-- Keep the SMS payment path inside the standard notification taxonomy and
-- make its notification idempotent per payment request.
CREATE OR REPLACE FUNCTION public.submit_payment_request(
  p_user_id uuid,
  p_plan_id text,
  p_amount numeric,
  p_method text,
  p_sender_number text,
  p_trx_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_sms_record RECORD;
  v_new_request_id UUID;
  v_plan_duration INT;
  v_plan_name TEXT;
  v_plan_name_en TEXT;
  v_current_end_date TIMESTAMP;
  v_new_end_date TIMESTAMP;
BEGIN

  IF EXISTS(
    SELECT 1 FROM payment_requests
    WHERE trx_id = p_trx_id AND status IN ('paid', 'pending')
  ) THEN
    RETURN jsonb_build_object('success', false, 'message', 'This TrxID is already used or pending verification!');
  END IF;

  SELECT id, status, extracted_amount
  INTO v_sms_record
  FROM payment_sms_logs
  WHERE extracted_trx_id = p_trx_id
  FOR UPDATE LIMIT 1;

  IF FOUND AND v_sms_record.status = 'unclaimed' THEN

    IF v_sms_record.extracted_amount < p_amount THEN
       RETURN jsonb_build_object('success', false, 'message', 'Payment amount mismatch. Please contact support.', 'status', 'failed');
    END IF;

    INSERT INTO payment_requests (id, user_id, plan_id, amount, method, sender_number, trx_id, status)
    VALUES (gen_random_uuid(), p_user_id, p_plan_id, p_amount, p_method, p_sender_number, p_trx_id, 'paid')
    RETURNING id INTO v_new_request_id;

    UPDATE payment_sms_logs
    SET status = 'claimed', linked_request_id = v_new_request_id
    WHERE id = v_sms_record.id;

    SELECT duration_days, name, coalesce(name_en, name) INTO v_plan_duration, v_plan_name, v_plan_name_en
    FROM subscription_plans WHERE id = p_plan_id;

    SELECT end_date INTO v_current_end_date
    FROM user_subscriptions
    WHERE user_id = p_user_id AND status = 'active'
    ORDER BY end_date DESC LIMIT 1;

    IF v_current_end_date IS NOT NULL AND v_current_end_date > now() THEN
      v_new_end_date := v_current_end_date + (v_plan_duration || ' days')::interval;
    ELSE
      v_new_end_date := now() + (v_plan_duration || ' days')::interval;
    END IF;

    INSERT INTO user_subscriptions (id, user_id, plan_id, payment_id, start_date, end_date, status, auto_renewal)
    VALUES (gen_random_uuid(), p_user_id, p_plan_id, v_new_request_id, now(), v_new_end_date, 'active', false);

    INSERT INTO notifications (target_user_id, title_bn, title_en, body_bn, body_en, type, channel, status, event_code, dedupe_key)
    VALUES (
      p_user_id,
      '🎉 পেমেন্ট সফল হয়েছে!',
      '🎉 Payment successful!',
      'আপনার ' || v_plan_name || ' প্যাকেজটি সফলভাবে চালু হয়েছে। মেয়াদ: ' || TO_CHAR(v_new_end_date, 'DD Mon YYYY'),
      'Your ' || v_plan_name_en || ' plan is now active. Valid until: ' || TO_CHAR(v_new_end_date, 'DD Mon YYYY'),
      'billing',
      'in_app',
      'sent',
      'premium_purchased',
      'premium_purchase:' || v_new_request_id::text
    );

    RETURN jsonb_build_object('success', true, 'message', 'Payment Approved! Subscription activated.', 'status', 'success');

  ELSE
    INSERT INTO payment_requests (id, user_id, plan_id, amount, method, sender_number, trx_id, status)
    VALUES (gen_random_uuid(), p_user_id, p_plan_id, p_amount, p_method, p_sender_number, p_trx_id, 'pending');

    RETURN jsonb_build_object('success', true, 'message', 'Request Submitted. Waiting for SMS verification.', 'status', 'pending');
  END IF;

END;
$function$;

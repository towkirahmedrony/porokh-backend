import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);
serve(async (req) => {
try {
const { sender, message } = await req.json();
let trxId = null, amount = null, provider = 'unknown';
if (sender.toLowerCase().includes("bkash")) {
provider = 'bkash';
const trxMatch = message.match(/TrxID (\w+)/i);
const amountMatch = message.match(/Tk ([\d,.]+)/i);
if (trxMatch) trxId = trxMatch[1];
if (amountMatch) amount = parseFloat(amountMatch[1].replace(/,/g, ''));
} else if (sender.toLowerCase().includes("nagad")) {
provider = 'nagad';
const trxMatch = message.match(/TxnID: (\w+)/i);
const amountMatch = message.match(/Amount: Tk ([\d,.]+)/i);
if (trxMatch) trxId = trxMatch[1];
if (amountMatch) amount = parseFloat(amountMatch[1].replace(/,/g, ''));
}
if (trxId && amount) {
const { error } = await supabase.from('payment_sms_logs').insert({
provider, sms_sender_number: sender, message_body: message,
extracted_trx_id: trxId, extracted_amount: amount,
message_type: 'cash_in', status: 'unclaimed'
});
if (error) throw error;
return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
}
return new Response(JSON.stringify({ success: false }), { headers: { "Content-Type": "application/json" } });
} catch (err) {
return new Response(JSON.stringify({ error: err.message }), { status: 500 });
}
});

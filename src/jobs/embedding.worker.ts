import cron from 'node-cron';
import { supabaseAdmin as supabase } from '../config/supabaseAdmin';
import logger from '../lib/utils/logger';
import { generateVectorEmbedding } from '../features/ai/ai.service';

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type WorkerOptions = {
  /** Overridable pacing timer; production uses the real timer. */
  delay?: (ms: number) => Promise<void>;
};

export const processStaleEmbeddings = async (options: WorkerOptions = {}) => {
  const sleep = options.delay ?? defaultSleep;

  try {
    const { data: staleQuestions, error: fetchError } = await supabase
      .from('questions')
      .select('id, body, explanation, subject_id')
      .eq('is_embedding_stale', true)
      // Ordering by id lets the partial index on `(id) WHERE is_embedding_stale`
      // answer this without a sort, and makes a batch deterministic. No keyset
      // cursor is kept: each processed row leaves the predicate, so the next run
      // naturally starts at the next stale row, while a row that failed stays
      // first in line to be retried.
      .order('id', { ascending: true })
      .limit(12);

    if (fetchError) {
      logger.error('Error fetching stale embeddings:', fetchError);
      return;
    }

    if (!staleQuestions || staleQuestions.length === 0) return;

    logger.info(`Started processing ${staleQuestions.length} stale embeddings...`);

    for (const question of staleQuestions) {
      try {
        const bodyText = typeof question.body === 'string'
          ? question.body
          : JSON.stringify(question.body ?? '');
        const explanation = question.explanation as { bn?: unknown; en?: unknown } | null;
        const explanationText = explanation && typeof explanation === 'object'
          ? [explanation.bn, explanation.en]
              .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
              .join('\n')
          : '';
        const textToEmbed = [bodyText, explanationText].filter(Boolean).join('\n');
        const embeddingVector = await generateVectorEmbedding(textToEmbed);

        // 👈 আপডেট: filter_subject_id ডাটাবেস থেকে বাদ দেওয়া হয়েছে 
        const { data: matches, error: matchError } = await supabase.rpc('match_questions', {
          query_embedding: JSON.stringify(embeddingVector), 
          match_threshold: 0.85,
          match_count: 2
        });

        if (matchError) {
          logger.error(`Match error for question ${question.id}:`, matchError);
          // যদি কোনো কারণে ম্যাচ এরর হয়ও, তবুও যেন প্রশ্ন pending এ আটকে না থাকে তাই সরাসরি পাবলিশ করা হচ্ছে
          await supabase.from('questions').update({
            embedding: JSON.stringify(embeddingVector),
            is_embedding_stale: false,
            embedding_updated_at: new Date().toISOString(),
            status: 'published',
            confidence_score: 95
          }).eq('id', question.id);
          continue;
        }

        const duplicate = matches?.find((m: { id: string, similarity: number }) => m.id !== question.id);

        const updatePayload: Record<string, string | boolean | number | null> = {
          embedding: JSON.stringify(embeddingVector),
          is_embedding_stale: false,
          embedding_updated_at: new Date().toISOString()
        };

        if (duplicate) {
          const similarityPercent = (duplicate.similarity * 100).toFixed(1);
          updatePayload.status = 'pending';
          updatePayload.audit_notes = `[System Flag] Potential duplicate of Question ID: ${duplicate.id} (${similarityPercent}% match).`;
          updatePayload.confidence_score = 65; 
        } else {
          updatePayload.status = 'published';
          updatePayload.confidence_score = 95;
        }

        const { error: updateError } = await supabase
          .from('questions')
          .update(updatePayload)
          .eq('id', question.id);

        if (updateError) {
           logger.error(`Failed to update DB for question ${question.id}:`, updateError);
        }

        await sleep(4000);

      } catch (qError: unknown) {
        const err = qError as Error;
        logger.error(`Failed processing question ${question.id}:`, err.message || err);
        
        if (err.message && err.message.includes('429')) {
           logger.warn('Rate limit hit on embedding API! Pausing worker for 1 minute...');
           await sleep(60000); 
        }
      }
    }

    logger.info(`Successfully finished embedding batch processing.`);

  } catch (error: unknown) {
    logger.error('Error in embedding worker:', error);
  }
};

export const startEmbeddingWorker = () => {
  cron.schedule('*/5 * * * *', () => {
    // Guard the scheduled body so a failure can only be logged, never become an
    // unhandled rejection that takes the API process down.
    void processStaleEmbeddings().catch((error) => {
      logger.error('Embedding worker run failed:', error);
    });
  });
  logger.info('Embedding Background Worker scheduled (runs every 5 minutes).');
};

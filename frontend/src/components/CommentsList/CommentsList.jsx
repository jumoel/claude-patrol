import { getRelativeTime } from '../../lib/time.js';
import { RenderedHtml } from '../RenderedHtml/RenderedHtml.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './CommentsList.module.css';

/** @type {Record<string, string>} */
const STATE_LABELS = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
};

/** @param {{state: string}} props */
function ReviewStateBadge({ state }) {
  const label = STATE_LABELS[state] || state.toLowerCase();
  const color = state === 'APPROVED' ? 'green' : state === 'CHANGES_REQUESTED' ? 'red' : 'gray';
  return <Badge color={color}>{label}</Badge>;
}

/** @param {{comment: import('../../types').InlineReviewComment}} props */
function InlineComment({ comment }) {
  const metadata = (
    <span className={styles.inlineMetadata}>
      <code className={styles.filePath}>{comment.path}</code>
      {comment.diff_position != null && <span className={styles.diffPos}>diff:{comment.diff_position}</span>}
    </span>
  );

  if (comment.resolved) {
    return (
      <details className={`${styles.inlineComment} ${styles.minimizedComment}`}>
        <summary className={styles.inlineSummary}>
          {metadata}
          <span className={styles.minimizedState}>resolved</span>
        </summary>
        <RenderedHtml html={comment.body_html} className={styles.commentBody} />
      </details>
    );
  }

  return (
    <div className={styles.inlineComment}>
      {metadata}
      <RenderedHtml html={comment.body_html} className={styles.commentBody} />
    </div>
  );
}

/** @param {{review: import('../../types').StructuredReview}} props */
function ReviewMetadata({ review }) {
  return (
    <>
      <span className={styles.author}>{review.author}</span>
      <ReviewStateBadge state={review.state} />
      {review.submitted_at && <span className={styles.timestamp}>{getRelativeTime(review.submitted_at)}</span>}
    </>
  );
}

/** @param {{review: import('../../types').StructuredReview}} props */
function ReviewContent({ review }) {
  return (
    <div className={styles.reviewContent}>
      {review.body_html && <RenderedHtml html={review.body_html} className={styles.commentBody} collapsible />}
      {review.comments.length > 0 && (
        <div className={styles.inlineList}>
          {review.comments.map((comment, index) => (
            <InlineComment key={index} comment={comment} />
          ))}
        </div>
      )}
    </div>
  );
}

/** @param {{review: import('../../types').StructuredReview}} props */
function ReviewCard({ review }) {
  if (review.state === 'DISMISSED') {
    return (
      <Box as="details" p={3} border borderColor="gray-100" rounded="lg" className={styles.reviewCard}>
        <summary className={styles.reviewSummary}>
          <span className={styles.reviewMetadata}>
            <ReviewMetadata review={review} />
          </span>
        </summary>
        <ReviewContent review={review} />
      </Box>
    );
  }

  return (
    <Box p={3} border borderColor="gray-100" rounded="lg" className={styles.reviewCard}>
      <div className={styles.reviewMetadata}>
        <ReviewMetadata review={review} />
      </div>
      <ReviewContent review={review} />
    </Box>
  );
}

/** @param {{comment: import('../../types').ConversationComment}} props */
function ConversationComment({ comment }) {
  return (
    <div className={styles.conversationItem}>
      <Stack gap={2}>
        <span className={styles.author}>{comment.author}</span>
        <span className={styles.timestamp}>{getRelativeTime(comment.created_at)}</span>
      </Stack>
      <RenderedHtml html={comment.body_html} className={styles.commentBody} collapsible />
    </div>
  );
}

/**
 * @param {{
 *   reviews?: import('../../types').StructuredReview[],
 *   conversation?: import('../../types').ConversationComment[],
 *   loading: boolean,
 * }} props
 */
export function CommentsList({ reviews, conversation, loading }) {
  if (loading) {
    return <LoadingIndicator className={styles.loading}>Loading comments...</LoadingIndicator>;
  }

  const hasReviews = reviews && reviews.length > 0;
  const hasConversation = conversation && conversation.length > 0;

  if (!hasReviews && !hasConversation) {
    return null;
  }

  return (
    <Stack direction="col" gap={5}>
      {hasReviews && (
        <Stack direction="col" gap={3}>
          <h4 className={styles.sectionTitle}>Review Comments</h4>
          {reviews.map((r) => (
            <ReviewCard key={r.id} review={r} />
          ))}
        </Stack>
      )}
      {hasConversation && (
        <Stack direction="col" gap={3}>
          <h4 className={styles.sectionTitle}>Conversation</h4>
          {conversation.map((c, i) => (
            <ConversationComment key={i} comment={c} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

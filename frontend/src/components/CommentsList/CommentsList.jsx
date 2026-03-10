import { getRelativeTime } from '../../lib/time.js';
import styles from './CommentsList.module.css';

const STATE_LABELS = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
};

function ReviewStateBadge({ state }) {
  const label = STATE_LABELS[state] || state.toLowerCase();
  const className = state === 'APPROVED'
    ? styles.badgeApproved
    : state === 'CHANGES_REQUESTED'
      ? styles.badgeChanges
      : styles.badgeComment;
  return <span className={`${styles.badge} ${className}`}>{label}</span>;
}

function InlineComment({ comment }) {
  return (
    <div className={styles.inlineComment}>
      <div className={styles.inlineHeader}>
        <code className={styles.filePath}>{comment.path}</code>
        {comment.diff_position != null && (
          <span className={styles.diffPos}>diff:{comment.diff_position}</span>
        )}
      </div>
      <div className={styles.commentBody}>{comment.body}</div>
    </div>
  );
}

function ReviewCard({ review }) {
  return (
    <div className={styles.reviewCard}>
      <div className={styles.reviewHeader}>
        <span className={styles.author}>{review.author}</span>
        <ReviewStateBadge state={review.state} />
        {review.submitted_at && (
          <span className={styles.timestamp}>{getRelativeTime(review.submitted_at)}</span>
        )}
      </div>
      {review.body && <div className={styles.commentBody}>{review.body}</div>}
      {review.comments.length > 0 && (
        <div className={styles.inlineList}>
          {review.comments.map((c, i) => (
            <InlineComment key={i} comment={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationComment({ comment }) {
  return (
    <div className={styles.conversationItem}>
      <div className={styles.conversationHeader}>
        <span className={styles.author}>{comment.author}</span>
        <span className={styles.timestamp}>{getRelativeTime(comment.created_at)}</span>
      </div>
      <div className={styles.commentBody}>{comment.body}</div>
    </div>
  );
}

export function CommentsList({ reviews, conversation, loading }) {
  if (loading) {
    return <p className={styles.loading}>Loading comments...</p>;
  }

  const hasReviews = reviews && reviews.length > 0;
  const hasConversation = conversation && conversation.length > 0;

  if (!hasReviews && !hasConversation) {
    return null;
  }

  return (
    <div className={styles.container}>
      {hasReviews && (
        <div className={styles.section}>
          <h4 className={styles.sectionTitle}>Review Comments</h4>
          {reviews.map(r => (
            <ReviewCard key={r.id} review={r} />
          ))}
        </div>
      )}
      {hasConversation && (
        <div className={styles.section}>
          <h4 className={styles.sectionTitle}>Conversation</h4>
          {conversation.map((c, i) => (
            <ConversationComment key={i} comment={c} />
          ))}
        </div>
      )}
    </div>
  );
}

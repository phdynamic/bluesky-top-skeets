/**
 * Labels that make a post's text unfit to store: adult, graphic and moderation labels. These are the
 * values in @atproto/api's own built-in label definitions (a test checks every one is still there),
 * not typed from memory.
 */
export const HIDE_LABELS = ['porn', 'sexual', 'nudity', 'graphic-media', 'gore', '!hide', '!warn', '!no-unauthenticated'];

export function hasHideLabel(post: { labels?: Array<{ val?: string }>; author?: { labels?: Array<{ val?: string }> } }): boolean {
  const all = [...(post.labels ?? []), ...(post.author?.labels ?? [])];
  return all.some(l => !!l && typeof l.val === 'string' && HIDE_LABELS.includes(l.val));
}

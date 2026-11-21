/** Images queued for the model's NEXT turn. The read_image tool and the design
 * preview tool push data URLs here; the agent loop flushes them into the
 * conversation as visible image blocks right after the tool result. */
export const pendingImages: string[] = [];

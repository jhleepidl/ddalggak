export function makeCancelledError(jobId = "") {
  const e = new Error(`Cancelled job ${String(jobId || "").trim()}`);
  e.code = "ECANCELLED";
  return e;
}

export function isCancelledError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  if (code === "ECANCELLED" || code === "ABORT_ERR") return true;
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("cancelled job")
    || message.includes("cancelled")
    || message.includes("aborted")
    || message.includes("aborterror");
}

export function createJobRuntimeState() {
  const jobAbortControllers = new Map();
  const activeJobByChat = new Map();
  const lastChatJobByChat = new Map();

  function resetJobAbortController(jobId) {
    const key = String(jobId || "").trim();
    const controller = new AbortController();
    jobAbortControllers.set(key, controller);
    return controller;
  }

  function cancelJobExecution(jobId, queue = []) {
    const key = String(jobId || "").trim();
    let aborted = false;
    const controller = jobAbortControllers.get(key);
    if (controller && !controller.signal.aborted) {
      controller.abort();
      aborted = true;
    }

    let dropped = 0;
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (String(queue[i]?.jobId ?? "") !== key) continue;
      queue[i].reject(makeCancelledError(key));
      queue.splice(i, 1);
      dropped += 1;
    }

    jobAbortControllers.delete(key);
    return { aborted, dropped };
  }

  return {
    jobAbortControllers,
    activeJobByChat,
    lastChatJobByChat,
    resetJobAbortController,
    cancelJobExecution,
  };
}

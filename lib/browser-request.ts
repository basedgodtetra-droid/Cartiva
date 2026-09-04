/** Includes the response body: receiving headers is not completion. */
export async function fetchBufferedResponse(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const work = (async () => {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error("The server returned too much data. Please try again.");
    return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
  })();
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("The connection timed out. Please try again.")); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
}

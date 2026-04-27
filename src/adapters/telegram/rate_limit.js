const DEFAULT_RETRY_BUFFER_MS = 1_000;
const DEFAULT_METHOD_GAP_MS = 250;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_NETWORK_RETRY_BASE_MS = 1_000;
const DEFAULT_NETWORK_RETRY_MAX_MS = 10_000;
const DEFAULT_QUEUED_METHODS = ['sendMessage', 'editMessageText', 'sendDocument', 'sendPhoto'];
const DEFAULT_FAST_METHODS = ['answerCallbackQuery'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function extractTelegramRetryAfter(error) {
  const candidates = [
    error?.response?.body?.parameters?.retry_after,
    error?.response?.body?.parameters?.retryAfter,
    error?.response?.parameters?.retry_after,
    error?.parameters?.retry_after,
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const text = [
    error?.response?.body?.description,
    error?.message,
    String(error || ''),
  ].filter(Boolean).join('\n');
  const match = text.match(/retry\s+after\s+(\d+(?:\.\d+)?)/i);
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function isTelegramRateLimitError(error) {
  const code = String(error?.code || '').toUpperCase();
  const errorCode = Number(error?.response?.body?.error_code ?? error?.response?.statusCode ?? 0);
  const message = String(error?.message || error?.response?.body?.description || '');
  return (code === 'ETELEGRAM' || errorCode === 429 || /too many requests/i.test(message))
    && (errorCode === 429 || /429|too many requests|retry after/i.test(message));
}

export function isTelegramNetworkError(error) {
  const code = String(error?.code || error?.errno || '').toUpperCase();
  const causeCode = String(error?.cause?.code || error?.cause?.errno || '').toUpperCase();
  const message = String(error?.message || error?.response?.body?.description || error || '');
  const networkCodes = new Set([
    'EFATAL',
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);
  if (networkCodes.has(code) || networkCodes.has(causeCode)) return true;
  return /(connect\s+)?ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network socket disconnected|TLS connection was|AggregateError/i.test(message);
}

function defaultShouldRetry(error) {
  return isTelegramRateLimitError(error) || isTelegramNetworkError(error);
}

export function createTelegramMethodRetrier({
  methodName = 'telegramMethod',
  call = async () => undefined,
  shouldRetry = defaultShouldRetry,
  maxRetries = parsePositiveInteger(process.env.TELEGRAM_SEND_MAX_RETRIES, DEFAULT_MAX_RETRIES),
  retryBufferMs = parsePositiveInteger(process.env.TELEGRAM_429_RETRY_BUFFER_MS, DEFAULT_RETRY_BUFFER_MS),
  networkRetryBaseMs = parsePositiveInteger(process.env.TELEGRAM_NETWORK_RETRY_BASE_MS, DEFAULT_NETWORK_RETRY_BASE_MS),
  networkRetryMaxMs = parsePositiveInteger(process.env.TELEGRAM_NETWORK_RETRY_MAX_MS, DEFAULT_NETWORK_RETRY_MAX_MS),
  logger = console.warn,
} = {}) {
  return async function retryingTelegramMethod(...args) {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await call(...args);
      } catch (error) {
        if (!shouldRetry(error) || attempt >= maxRetries) throw error;
        attempt += 1;
        const isRateLimit = isTelegramRateLimitError(error);
        const retryAfterSec = isRateLimit ? extractTelegramRetryAfter(error) : 0;
        const delayMs = retryAfterSec > 0
          ? Math.max(0, Math.ceil(retryAfterSec * 1000) + retryBufferMs)
          : Math.min(networkRetryMaxMs, Math.max(0, networkRetryBaseMs) * Math.max(1, 2 ** (attempt - 1)));
        try {
          const kind = isRateLimit ? 'rate-limited' : 'network error';
          logger(`[telegram] ${methodName} ${kind}; retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${attempt}/${maxRetries})`);
        } catch {}
        await sleep(delayMs);
      }
    }
  };
}

function makeSerialQueue() {
  let queue = Promise.resolve();
  return function enqueue(run) {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
}

function uniqueMethodNames(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

export function installTelegramRateLimitRetry(bot, {
  methods,
  queuedMethods = DEFAULT_QUEUED_METHODS,
  fastMethods = DEFAULT_FAST_METHODS,
  methodGapMs = parsePositiveInteger(process.env.TELEGRAM_SEND_METHOD_GAP_MS, DEFAULT_METHOD_GAP_MS),
  fastMethodGapMs = 0,
  maxRetries = parsePositiveInteger(process.env.TELEGRAM_SEND_MAX_RETRIES, DEFAULT_MAX_RETRIES),
  retryBufferMs = parsePositiveInteger(process.env.TELEGRAM_429_RETRY_BUFFER_MS, DEFAULT_RETRY_BUFFER_MS),
  networkRetryBaseMs = parsePositiveInteger(process.env.TELEGRAM_NETWORK_RETRY_BASE_MS, DEFAULT_NETWORK_RETRY_BASE_MS),
  networkRetryMaxMs = parsePositiveInteger(process.env.TELEGRAM_NETWORK_RETRY_MAX_MS, DEFAULT_NETWORK_RETRY_MAX_MS),
  logger = console.warn,
} = {}) {
  if (!bot || typeof bot !== 'object') return bot;
  if (bot.__ddalggakRateLimitRetryInstalled) return bot;
  Object.defineProperty(bot, '__ddalggakRateLimitRetryInstalled', {
    value: true,
    enumerable: false,
    configurable: false,
  });

  const allMethods = uniqueMethodNames(methods || [...queuedMethods, ...fastMethods]);
  const queuedSet = new Set(uniqueMethodNames(queuedMethods));
  const fastSet = new Set(uniqueMethodNames(fastMethods));
  const enqueueSend = makeSerialQueue();

  for (const methodName of allMethods) {
    const original = bot[methodName];
    if (typeof original !== 'function') continue;
    const retrying = createTelegramMethodRetrier({
      methodName,
      call: (...args) => original.apply(bot, args),
      maxRetries,
      retryBufferMs,
      networkRetryBaseMs,
      networkRetryMaxMs,
      logger,
    });
    bot[methodName] = (...args) => {
      const isFast = fastSet.has(methodName) && !queuedSet.has(methodName);
      const gapMs = isFast ? fastMethodGapMs : methodGapMs;
      const run = async () => {
        if (gapMs > 0) await sleep(gapMs);
        return retrying(...args);
      };
      return isFast ? run() : enqueueSend(run);
    };
  }
  return bot;
}

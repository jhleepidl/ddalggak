import { chunk } from "../../textutil.js";

export async function sendLong(bot, chatId, text) {
  for (const part of chunk(String(text || ""), 3800)) {
    await bot.sendMessage(chatId, part);
  }
}

export async function sendTextWithOptionalGocButton(
  bot,
  chatId,
  text,
  {
    miniAppLink = "",
    browserLink = "",
    miniAppLabel = "Open GoC (Mini App)",
    browserLabel = "Open GoC (Browser)",
    isHttps = (value) => String(value || "").trim().toLowerCase().startsWith("https://"),
    isTelegramWebAppHttpsError = () => false,
  } = {}
) {
  const cleanText = String(text || "").trim();
  if (!cleanText) return;
  const cleanMiniAppLink = String(miniAppLink || "").trim();
  const cleanBrowserLink = String(browserLink || "").trim();

  if (!cleanMiniAppLink && !cleanBrowserLink) {
    await sendLong(bot, chatId, cleanText);
    return;
  }

  const buttons = [];
  const hasMiniApp = isHttps(cleanMiniAppLink);
  const cleanMiniAppLabel = String(miniAppLabel || "Open GoC (Mini App)").trim() || "Open GoC (Mini App)";
  const cleanBrowserLabel = String(browserLabel || "Open GoC (Browser)").trim() || "Open GoC (Browser)";
  if (hasMiniApp) {
    buttons.push({ text: cleanMiniAppLabel, web_app: { url: cleanMiniAppLink } });
  }
  if (cleanBrowserLink) {
    buttons.push({ text: cleanBrowserLabel, url: cleanBrowserLink });
  } else if (cleanMiniAppLink) {
    buttons.push({ text: cleanBrowserLabel, url: cleanMiniAppLink });
  }

  if (buttons.length === 0) {
    await sendLong(bot, chatId, cleanText);
    return;
  }

  try {
    await bot.sendMessage(chatId, cleanText, {
      reply_markup: {
        inline_keyboard: [buttons],
      },
    });
  } catch (e) {
    if (hasMiniApp && isTelegramWebAppHttpsError(e)) {
      const fallbackText = `${cleanText}\n\nMini App 버튼은 HTTPS만 지원합니다. 지금은 브라우저 링크를 사용하세요.`;
      const browserOnly = cleanBrowserLink
        ? [{ text: cleanBrowserLabel, url: cleanBrowserLink }]
        : [{ text: cleanBrowserLabel, url: cleanMiniAppLink }];
      await bot.sendMessage(chatId, fallbackText, {
        reply_markup: {
          inline_keyboard: [browserOnly],
        },
      });
      return;
    }
    throw e;
  }
}

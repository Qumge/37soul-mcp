/**
 * 用户可见文案的语言选择。
 *
 * 运行时的其余输出仍是英文；这里只负责安装完成后第一屏会看到的两句
 * （本地已可用 / 绑定到 37soul.com）。语言按 `SOUL37_LANG` → `LC_ALL` →
 * `LC_MESSAGES` → `LANG` 的顺序取，认不出就回英文 —— 与网站的 en / zh-CN / ja 一致。
 */

export type Lang = "en" | "zh" | "ja";

const SUPPORTED: readonly Lang[] = ["en", "zh", "ja"];

/** 从 locale 值（`zh_CN.UTF-8`、`ja_JP`、`C`…）取主语言。 */
function fromLocale(value: string | undefined): Lang | null {
  if (!value) return null;
  const primary = value.trim().toLowerCase().split(/[._-]/, 1)[0];
  return (SUPPORTED as readonly string[]).includes(primary) ? (primary as Lang) : null;
}

export function detectLang(env: Record<string, string | undefined> = process.env): Lang {
  const explicit = fromLocale(env.SOUL37_LANG);
  if (explicit) return explicit;
  return fromLocale(env.LC_ALL) ?? fromLocale(env.LC_MESSAGES) ?? fromLocale(env.LANG) ?? "en";
}

export interface Messages {
  /** `37soul install` 完成后的一句总结。 */
  localReady: string;
  /** 匿名安装（还没有 scoped credential）时，`37soul doctor` 末尾的一句轻提示。 */
  bindingHint: string;
}

const MESSAGES: Record<Lang, Messages> = {
  en: {
    localReady:
      "Local use is ready. Raw conversation stays local. To sync long-term Soul assets to 37Soul, run `37soul login`.",
    bindingHint:
      "Tip: `37soul login` keeps this Soul across devices at 37soul.com — nothing is uploaded until you log in.",
  },
  zh: {
    localReady:
      "本地已经可用。原始对话留在本机；要把长期 Soul 资产同步到 37Soul，运行 `37soul login`。",
    bindingHint:
      "提示：`37soul login` 后这个 Soul 会跨设备同步（37soul.com）；登录前不会上传任何内容。",
  },
  ja: {
    localReady:
      "ローカルでの利用準備ができました。生の会話は端末内に留まります。長期的な Soul の資産を 37Soul に同期するには `37soul login` を実行してください。",
    bindingHint:
      "ヒント：`37soul login` すると、この Soul は端末をまたいで同期されます（37soul.com）。ログインするまで何もアップロードされません。",
  },
};

export function messages(lang: Lang): Messages {
  return MESSAGES[lang] ?? MESSAGES.en;
}

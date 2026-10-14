/**
 * v150 — من Markdown إلى نصٍّ يُقرأ، واختيارُ الصوت (القراءةُ بصوت المتصفّح، المرحلة 2).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ ما يُثبَّت هنا قرارٌ لا مصادفة
 *
 *  كتلُ الكود لا تُقرأ. الروابطُ يُقرأ نصُّها لا عنوانُها. الجداولُ تُقرأ
 *  خلاياها. الرموزُ التصويريّة تُحذف. وكلُّ ذلك موثَّقٌ في
 *  docs/browser-voice.md — فمن غيّره غيّر الوثيقةَ وهذا الملفَّ معًا.
 *
 *  ★ واللغةُ تُحسم من النصّ
 *
 *  لا من لغة الواجهة: المستخدمُ بواجهةٍ عربيّة يسأل بالإنجليزيّة فيُجاب
 *  بها. والصوتُ الخطأ أسوأ من لا صوت — فلا يُعطى نصٌّ عربيٌّ صوتًا
 *  إنجليزيًّا.
 * ══════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from "vitest";

import {
  MAX_CHUNK_CHARS,
  chunkSpeechText,
  countScripts,
  detectSpeechLanguage,
  isSupportedSpeechLanguage,
  toSpeechText,
} from "@/lib/browser-voice/speech-text";
import {
  ALLOW_NETWORK_VOICES,
  DEFAULT_LANG_TAG,
  isReportedDeviceVoice,
  normalizeLangTag,
  pickVoice,
} from "@/lib/browser-voice/voices";
import { AR_EG, AR_SA, EN_GB, EN_US, voice } from "./helpers/fake-speech";

describe("v150 — لغةُ النصّ", () => {
  it("العربيّةُ الغالبة ⇒ ar، والإنجليزيّةُ الغالبة ⇒ en", () => {
    expect(detectSpeechLanguage("هذا ردٌّ عربيٌّ فيه كلمة API واحدة")).toBe("ar");
    expect(detectSpeechLanguage("This answer mentions كلمة once")).toBe("en");
  });

  it("بلا حروفٍ أو عند التعادل ⇒ ما يُورَّث — والافتراضُ عربيّ", () => {
    expect(detectSpeechLanguage("12345 — 67")).toBe("ar");
    expect(detectSpeechLanguage("12345", "en")).toBe("en");
    expect(detectSpeechLanguage("ab اب")).toBe("ar");
    expect(detectSpeechLanguage("ab اب", "en")).toBe("en");
    expect(detectSpeechLanguage("")).toBe("ar");
  });

  /** ★ الفاصلةُ والأرقامُ العربيّة ليست حروفًا: لا تقلب سطرًا إنجليزيًّا */
  it("علاماتُ الترقيم والأرقامُ العربيّة لا تُحسب حروفًا", () => {
    expect(detectSpeechLanguage("Hello، ؛ ؟ ٠١٢٣٤٥٦٧٨٩ world")).toBe("en");
  });

  it("حروفٌ لاتينيّة بعلاماتٍ (français) تُحسب لاتينيّة", () => {
    expect(detectSpeechLanguage("déjà vu café")).toBe("en");
  });
});

describe("v150 — ما يُزال من Markdown ويبقى الكلام", () => {
  it("العناوينُ والقوائمُ والاقتباس: تذهب العلامةُ ويبقى النصّ بوقفة", () => {
    const out = toSpeechText("# العنوان\n\n- بندٌ أوّل\n* بندٌ ثانٍ\n+ بندٌ ثالث\n\n> اقتباسٌ قصير");
    expect(out.split("\n")).toEqual(["العنوان.", "بندٌ أوّل.", "بندٌ ثانٍ.", "بندٌ ثالث.", "اقتباسٌ قصير."]);
  });

  it("القائمةُ المرقّمة تحتفظ برقمها", () => {
    expect(toSpeechText("1. أوّلًا\n2. ثانيًا")).toBe("1. أوّلًا.\n2. ثانيًا.");
  });

  it("السطرُ المنتهي بوقفةٍ لا يُزاد عليه", () => {
    expect(toSpeechText("هل هذا سؤال؟")).toBe("هل هذا سؤال؟");
    expect(toSpeechText("Done!")).toBe("Done!");
    expect(toSpeechText("الخطوات:")).toBe("الخطوات:");
  });

  it("التوكيدُ والشطبُ والكودُ السطريّ: تذهب العلامات", () => {
    expect(toSpeechText("هذا **مهمّ** و*مائل* و__ثقيل__ و~~مشطوب~~ و`npm test`.")).toBe(
      "هذا مهمّ ومائل وثقيل ومشطوب وnpm test.",
    );
  });

  /** ★ `snake_case` ليس توكيدًا: الشرطةُ السفليّة داخل الكلمة تبقى */
  it("الشرطةُ السفليّة داخل الكلمة تبقى، وعلى حدّها تُزال", () => {
    expect(toSpeechText("use snake_case and _emphasis_ here.")).toBe("use snake_case and emphasis here.");
  });

  it("الرابطُ يُقرأ نصُّه لا عنوانُه، والصورةُ وصفُها", () => {
    expect(toSpeechText("راجع [الوثيقة](https://example.com/a?b=1) ثم ![شعار YSD](https://x.test/l.png).")).toBe(
      "راجع الوثيقة ثم شعار YSD.",
    );
    expect(toSpeechText("See [the docs][ref] now.")).toBe("See the docs now.");
  });

  it("العناوينُ العارية والمحصورةُ بين زاويتين لا تُقرأ", () => {
    expect(toSpeechText("الموقع https://example.com/path?x=1 مفيد.")).toBe("الموقع مفيد.");
    expect(toSpeechText("visit <https://example.com> or www.example.org today.")).toBe("visit or today.");
  });

  /** ★ كتلُ الكود لا تُقرأ — قرارٌ موثَّق */
  it("كتلةُ الكود المسيَّجة تُحذف كلُّها، وما حولها يبقى", () => {
    const md = "قبل الكود.\n\n```ts\nconst x: number = 1;\nconsole.log(x);\n```\n\nبعد الكود.";
    expect(toSpeechText(md)).toBe("قبل الكود.\nبعد الكود.");
  });

  it("سياجُ `~~~` وسياجٌ أطول يُغلقان بمثلهما", () => {
    expect(toSpeechText("أ.\n~~~\ncode\n~~~\nب.")).toBe("أ.\nب.");
    expect(toSpeechText("أ.\n````md\n```\ninner\n```\n````\nب.")).toBe("أ.\nب.");
  });

  /** ★ البثُّ المقطوع يترك سياجًا مفتوحًا: ما بعده كودٌ لا كلام */
  it("السياجُ غيرُ المغلق يبتلع ما بعده", () => {
    expect(toSpeechText("شرح.\n```py\nprint(1)\nprint(2)")).toBe("شرح.");
  });

  it("ردٌّ كلُّه كود ⇒ لا شيءَ يُقرأ", () => {
    expect(toSpeechText("```js\nalert(1)\n```")).toBe("");
    expect(toSpeechText("   \n\n")).toBe("");
    expect(toSpeechText("---\n***\n")).toBe("");
  });

  it("الجدولُ تُقرأ خلاياه بالترتيب، وصفُّ الفواصل يُحذف", () => {
    const md = "| الاسم | العمر |\n|:-----|-----:|\n| سارة | 30 |\n| Omar | 25 |";
    expect(toSpeechText(md).split("\n")).toEqual(["الاسم، العمر.", "سارة، 30.", "Omar, 25."]);
  });

  it("الخطُّ الفاصل يُحذف، ووسومُ HTML تذهب ويبقى ما بينها", () => {
    expect(toSpeechText("أوّل.\n\n---\n\nثانٍ<br>ثالث <b>غامق</b>.")).toBe("أوّل.\nثانٍ ثالث غامق.");
  });

  it("الحواشي وأرقامُ المراجع تُحذف — لا فهرسةُ المصفوفة", () => {
    expect(toSpeechText("الحقيقة ثابتة [1] ومؤكَّدة[^note].")).toBe("الحقيقة ثابتة ومؤكَّدة.");
    expect(toSpeechText("read items[0] first.")).toBe("read items[0] first.");
  });

  it("مربّعاتُ المهامّ والهروبُ والكيانات", () => {
    expect(toSpeechText("- [x] تمّ\n- [ ] لم يتمّ")).toBe("تمّ.\nلم يتمّ.");
    expect(toSpeechText("5 \\* 3 &amp; 2 &lt; 9.")).toBe("5 * 3 & 2 < 9.");
  });

  /** ★ المحرّكُ ينطق اسمَ الرمز بالإنجليزيّة وسط الجملة العربيّة */
  it("الرموزُ التصويريّة تُحذف", () => {
    expect(toSpeechText("أحسنت 🎉👍🏽 يا صديقي ❤\uFE0F.")).toBe("أحسنت يا صديقي.");
    expect(toSpeechText("✅")).toBe("");
  });

  it("فواصلُ الأسطر بأنواعها، والفراغُ الزائد", () => {
    expect(toSpeechText("أ.\r\nب.\rج.")).toBe("أ.\nب.\nج.");
    expect(toSpeechText("كلمة    ثم\tكلمة.")).toBe("كلمة ثم كلمة.");
  });

  /** ★ دالّةٌ محضة: الخادمُ والمتصفّحُ يحسمان إظهارَ الزرّ بالنتيجة نفسِها */
  it("حتميّة: المدخلُ نفسُه ⇒ المخرجُ نفسُه", () => {
    const md = "## عنوان\n\nنصٌّ **مهمّ** مع [رابط](https://a.b).\n\n```\nx\n```";
    expect(toSpeechText(md)).toBe(toSpeechText(md));
  });
});

/**
 * ★ عيوبٌ كشفتها المراجعةُ المعادية — وكلٌّ منها يُسمع.
 *
 * ما يُحذف بغير حقّ كلامٌ لم يُقرأ، وما يبقى بغير حقّ ضجيجٌ يُنطق، ورقمٌ
 * يتبدّل معلومةٌ خاطئة بصوتٍ واثق.
 */
describe("v150 — السياج كما يراه العارض", () => {
  const F = "```";

  /** ★ ثلاثُ نقراتٍ تفتح وتغلق على السطر نفسِه كودٌ سطريّ: كانت تُعدّ فاتحَ سياجٍ فيبتلع بقيّةَ الرد */
  it("ثلاثُ نقراتٍ على سطرٍ واحد ⇒ كودٌ سطريّ يُقرأ، وما بعده باقٍ", () => {
    expect(toSpeechText(`To install, run:\n\n${F}npm install${F}\n\nThen start the server and open the page.`)).toBe(
      "To install, run:\nnpm install.\nThen start the server and open the page.",
    );
  });

  it("وبعده كتلةٌ حقيقيّة: النثرُ يُقرأ والكتلةُ لا تُقرأ — لا العكس", () => {
    const md = `ثبّت الحزمة:\n\n${F}pip install requests${F}\n\nثم شغّل البرنامج واقرأ النتيجة.\n\n${F}python\nimport requests\n${F}\n\nانتهى الشرح.`;
    expect(toSpeechText(md)).toBe("ثبّت الحزمة:\npip install requests.\nثم شغّل البرنامج واقرأ النتيجة.\nانتهى الشرح.");
  });

  it("سياجٌ بعد علامة قائمة، وغالقُه المُزاح لا يُعدّ فاتحًا جديدًا", () => {
    expect(toSpeechText(`1. ${F}bash\n   npm install\n   ${F}\n2. Then run it.\n\nFinally, open the app.`)).toBe(
      "2. Then run it.\nFinally, open the app.",
    );
  });

  it("سياجٌ داخل اقتباس", () => {
    expect(toSpeechText(`> ${F}js\n> const a = 1;\n> ${F}\n\nAfter the quote.`)).toBe("After the quote.");
  });

  it("سياجٌ أطول يحوي سياجًا أقصر: لا يُغلقه إلا مثلُه", () => {
    expect(toSpeechText(`${F}\`markdown\n${F}js\nconsole.log(1);\n${F}\n${F}\`\n\nThat is all.`)).toBe("That is all.");
  });

  it("غالقُ السياج لا نصَّ بعده: سطرُ كودٍ يبدأ بثلاث نقرات لا يُغلق الكتلة", () => {
    expect(toSpeechText(`قبل.\n${F}md\n${F}js is how you open one\nstill code\n${F}\nبعد.`)).toBe("قبل.\nبعد.");
  });
});

describe("v150 — حروفٌ من الكلام لا علاماتُ تنسيق", () => {
  /** ★ ★ ★ «2**3 = 8» كانت تُقرأ «23 = 8» — رقمٌ ليس في الرد */
  it("نجمةُ الضرب والأسّ تبقى: لا رقمَ يتبدّل", () => {
    expect(toSpeechText("**النتيجة:** 3 * 4 = 12 و 2**3 = 8 و 5*6=30.")).toBe("النتيجة: 3 * 4 = 12 و 2**3 = 8 و 5*6=30.");
    expect(toSpeechText("2 * 3 * 4 = 24")).toBe("2 * 3 * 4 = 24.");
    expect(toSpeechText("٥*٦=٣٠")).toBe("٥*٦=٣٠.");
    expect(toSpeechText("حاصل ضرب 7*8 هو 56.")).toBe("حاصل ضرب 7*8 هو 56.");
  });

  it("ما في الكود السطريّ يبقى كما هو: نجمةٌ وشرطةٌ سفليّة وزاويةٌ وقوس", () => {
    expect(toSpeechText("In Python `2**10` equals 1024.")).toBe("In Python 2**10 equals 1024.");
    expect(toSpeechText("Match `*.ts` files and `src/**/*.tsx`.")).toBe("Match *.ts files and src/**/*.tsx.");
    expect(toSpeechText("Run `SELECT * FROM users` first.")).toBe("Run SELECT * FROM users first.");
    expect(toSpeechText("call `__init__` then `items[0]` and `a[1]`.")).toBe("call __init__ then items[0] and a[1].");
  });

  it("والتوكيدُ الحقيقيّ ما زال يُزال", () => {
    expect(toSpeechText("هذا **مهمّ** و*مائل* و__ثقيل__ و~~مشطوب~~.")).toBe("هذا مهمّ ومائل وثقيل ومشطوب.");
    expect(toSpeechText("*Note:* read **all** of it.")).toBe("Note: read all of it.");
  });

  /** ★ «كلُّ ما بين زاويتين وسم» كان يحذف كلامًا من الرد */
  it("الزاويةُ ليست وسمًا: المقارنةُ والعنصرُ النائب والنوعُ العامّ تبقى", () => {
    expect(toSpeechText("Use the `<br>` tag, return `Promise<void>`, run `git checkout <branch-name>`.")).toBe(
      "Use the <br> tag, return Promise<void>, run git checkout <branch-name>.",
    );
    expect(toSpeechText("when x<y and y>z we stop, replace <YOUR_API_KEY> with your key.")).toBe(
      "when x<y and y>z we stop, replace <YOUR_API_KEY> with your key.",
    );
    expect(toSpeechText("إذا كان x <y و y> z فتوقف.")).toBe("إذا كان x <y و y> z فتوقف.");
  });

  it("والوسومُ المعروفة خارج الكود ما زالت تُزال", () => {
    expect(toSpeechText("ثانٍ<br>ثالث <b>غامق</b>.")).toBe("ثانٍ ثالث غامق.");
    expect(toSpeechText("<details><summary>More</summary>hidden text</details>")).toBe("More hidden text.");
    expect(toSpeechText('a <span class="x">b</span> c <img src="x.png" alt="y"/> d')).toBe("a b c d.");
  });

  it("أرقامُ المراجع المتجاورة تُحذف كلُّها ولا تترك رقمًا يُنطق", () => {
    expect(toSpeechText("الماء يغلي عند 100 درجة [1][2]. والجليد يذوب عند صفر [3][4][5].")).toBe(
      "الماء يغلي عند 100 درجة. والجليد يذوب عند صفر.",
    );
  });

  /** ★ النقطةُ أوّلَ الكلمة ليست آخرَ جملة */
  it("«.gitignore» و«.NET» لا تلتصقان بما قبلهما", () => {
    expect(toSpeechText("Add it to .gitignore and use .NET 8.")).toBe("Add it to .gitignore and use .NET 8.");
  });

  it("عنوانٌ بعلاماتٍ خاتمة، ورابطٌ في عنوانه قوسان، وعنوانٌ عارٍ بقوسين", () => {
    expect(toSpeechText("## الخلاصة ##")).toBe("الخلاصة.");
    expect(toSpeechText("See [Mercury](https://en.wikipedia.org/wiki/Mercury_(planet)) for details.")).toBe("See Mercury for details.");
    expect(toSpeechText("انظر https://en.wikipedia.org/wiki/Mercury_(planet) للمزيد.")).toBe("انظر للمزيد.");
  });

  it("تعريفُ الحاشية يُقرأ نصُّه، وتعريفُ مرجع الرابط لا يُقرأ", () => {
    expect(toSpeechText("Fact[^1] here.\n\n[^1]: The footnote text.")).toBe("Fact here.\nThe footnote text.");
    expect(toSpeechText('See [the docs][ref].\n\n[ref]: https://example.com "Docs"')).toBe("See the docs.");
  });

  it("الكياناتُ المسمّاة والرقميّة تُفكّ", () => {
    expect(toSpeechText("Tom &mdash; Jerry &hellip; &#65;&#x42;")).toBe("Tom — Jerry… AB.");
  });
});

describe("v150 — الجداول", () => {
  it("جدولٌ بلا عمودين خارجيّين يُقرأ خلايا لا أعمدةً تُنطق", () => {
    expect(toSpeechText("Name | Age\n--- | ---\nSara | 30")).toBe("Name, Age.\nSara, 30.");
  });

  it("العمودُ المهروب به جزءٌ من الخليّة", () => {
    expect(toSpeechText("| Cmd | Meaning |\n|---|---|\n| a \\| b | pipe |")).toBe("Cmd, Meaning.\na | b, pipe.");
  });

  it("صفُّ أرقامٍ يأخذ فاصلةَ لغة الرد لا الفاصلةَ العربيّة دائمًا", () => {
    expect(toSpeechText("Sales by year:\n\n| 2022 | 100 |\n|---|---|\n| 2023 | 150 |")).toBe(
      "Sales by year:\n2022, 100.\n2023, 150.",
    );
    expect(toSpeechText("المبيعات بالسنة:\n\n| 2022 | 100 |\n|---|---|\n| 2023 | 150 |")).toBe(
      "المبيعات بالسنة:\n2022، 100.\n2023، 150.",
    );
  });

  it("عمودٌ في جملةٍ عاديّة ليس جدولًا", () => {
    expect(toSpeechText("Use a | b to pipe output.")).toBe("Use a | b to pipe output.");
  });

  it("ينتهي الجدولُ بسطرٍ فارغ: ما بعده نثر", () => {
    expect(toSpeechText("a | b\n--- | ---\n1 | 2\n\nThen a | b in prose.")).toBe("a, b.\n1, 2.\nThen a | b in prose.");
  });

  /** ★ «\|» في خليّةٍ عمودٌ من الكلام — ولو داخل كودٍ سطريّ، حيث لا يُفكّ هروبٌ آخر */
  it("عمودٌ مهروب داخل كودٍ سطريّ في خليّة يُقرأ بلا شرطته", () => {
    expect(toSpeechText("| Operator | Meaning |\n|---|---|\n| `a \\| b` | bitwise OR |\n| `a \\|\\| b` | logical OR |")).toBe(
      "Operator, Meaning.\na | b, bitwise OR.\na || b, logical OR.",
    );
    expect(toSpeechText("| `git log --oneline \\| head` | Short log |\n|---|---|\n| x \\| y | z |")).toBe(
      "git log --oneline | head, Short log.\nx | y, z.",
    );
    // وخارجَ الجدول الكودُ السطريّ لا يُمسّ
    expect(toSpeechText("Use `a \\| b` outside a table.")).toBe("Use a \\| b outside a table.");
  });
});

describe("v150 — لا تعبيرَ يتراجع بلا حدّ", () => {
  /**
   * ★ الدالّةُ تُحسب لكلّ ردٍّ مكتمل عند رسمه — قبل أيّ ضغطة.
   *
   * كانت تسعةُ تعابيرَ تربيعيّة: سطرٌ من مئة ألف فراغٍ يجمّد الصفحةَ ثماني
   * ثوانٍ، ومئةُ ألف قوسٍ ستًّا وأربعين. والحدُّ هنا واسعٌ عمدًا (ثانيةٌ ونصف
   * لمئة ألف حرف على مُشغِّلٍ بطيء) — والتربيعيُّ يتجاوزه بأضعاف.
   */
  const N = 100_000;
  const INPUTS: Array<[string, string]> = [
    ["leading spaces", `${" ".repeat(N)}x`],
    ["dashes then spaces", `--${" ".repeat(N)}x`],
    ["open brackets", "[".repeat(N)],
    ["image openers", "![".repeat(N / 2)],
    ["footnote openers", "[^".repeat(N / 2)],
    ["unclosed links", "[a](".repeat(N / 4)],
    ["tag openers", "<a".repeat(N / 2)],
    ["autolink openers", "<http://".repeat(N / 8)],
    ["underscore and tilde", `a${"_~~".repeat(N / 3)}x`],
    ["backticks", "`".repeat(N)],
    ["asterisks", "*".repeat(N)],
    ["pipes", "|".repeat(N)],
    ["backslashes", "\\".repeat(N)],
    ["open parentheses", `[a](${"(".repeat(N)}`],
    ["one unbroken word", "ب".repeat(N)],
    ["wide table row", `|${" a |".repeat(N / 4)}`],
    ["ampersands", "&a".repeat(N / 2)],
    ["closers after a space", `ب ${")".repeat(N)}`],
    ["five thousand lines", Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")],
    // ★ الجولةُ الثانية: إصلاحُ العنوان أدخل تعبيرًا تربيعيًّا عاشرًا — وهذه أشكالُه وأشكالُ ما أُضيف بعده
    ["heading with an inner gap", `## a${" ".repeat(N)}b`],
    ["heading with inner tabs", `## a${"\t".repeat(N)}b`],
    ["quoted heading with a gap", `> ## Title${" ".repeat(N)}end`],
    ["tag name then spaces", `<a${" ".repeat(N)}x`],
    ["tag attributes", "<a b=c ".repeat(N / 7)],
    ["label then words", `[a]: ${"x ".repeat(N / 2)}`],
    ["bold openers", "**a".repeat(N / 3)],
    ["lone stars", "*a ".repeat(N / 3)],
    ["double underscores", "__a".repeat(N / 3)],
    ["digit stars", "1*".repeat(N / 2)],
    ["citation run", "[1]".repeat(N / 3)],
    ["code spans", "`a` ".repeat(N / 4)],
    ["many fences", Array.from({ length: 3000 }, () => "```\nx\n```").join("\n")],
    // ★ الجولةُ الثالثة: البحثُ من كلّ جملةٍ بلا حروف عمّا يتلوها كان تربيعيًّا في التقطيع (خمسون ثانيةً لهذا السطر)
    ["letterless sentences", "1. ".repeat(N / 3)],
    ["letterless sentences then prose", `${"1. ".repeat(N / 6)}${"word ".repeat(N / 10)}.`],
    ["arabic-indic numbered sentences", "٣. ".repeat(N / 3)],
    ["question marks after digits", `${"7? ".repeat(N / 3)}word`],
    // ★ الجولةُ الرابعة: حارسُ الغالق بعد القوس، والتوكيدُ المتداخل، والهروبُ الموسَّع
    ["bracket closers", "*a (b)*2 ".repeat(N / 9)],
    ["stray opener then bracket stars", `*a ${"(b)*2 ".repeat(N / 6)}`],
    ["bold bracket closers", `**a ${"(b)**2 ".repeat(N / 7)}`],
    ["nested emphasis", "**a *b* c** ".repeat(N / 12)],
    ["escaped carets", "\\^".repeat(N / 2)],
  ];

  it.each(INPUTS)("%s (100,000 حرف) ⇒ يُحوَّل ويُقطَّع في زمنٍ خطّيّ", (_name, input) => {
    const started = performance.now();
    const text = toSpeechText(input);
    const chunks = chunkSpeechText(text);
    chunkSpeechText(input);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1500);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it("ومضاعفةُ الطول لا تُربّع الزمن", () => {
    const time = (n: number) => {
      const input = `${" ".repeat(n)}x\n${"[".repeat(n)}\n${"<a".repeat(n / 2)}`;
      const started = performance.now();
      toSpeechText(input);
      return performance.now() - started;
    };
    time(20_000);
    const small = Math.max(time(40_000), 0.5);
    const large = time(160_000);
    // أربعةُ أضعاف الطول: الخطّيُّ ~4× والتربيعيُّ ~16×
    expect(large / small).toBeLessThan(10);
  });
});

/**
 * ★ ما كشفته الجولةُ الثانية من المراجعة — ومنه تراجعٌ أدخلته إعادةُ الكتابة نفسُها.
 */
describe("v150 — كلامٌ يشبه التنسيق وليس منه", () => {
  const F = "```";

  /** ★ ★ ★ تراجُع: «[المستخدم]: …» كانت تُعدّ تعريفَ رابط فتُحذف — وردٌّ كلُّه حوارٌ يفقد زرَّه */
  it("سطرٌ يبدأ بوسمٍ بين قوسين ثم نقطتين كلامٌ يُقرأ: حوارٌ، وملاحظةٌ، وتوقيت", () => {
    expect(toSpeechText("[المستخدم]: ما عاصمة فرنسا؟\n[المساعد]: عاصمة فرنسا هي باريس.")).toBe(
      "[المستخدم]: ما عاصمة فرنسا؟\n[المساعد]: عاصمة فرنسا هي باريس.",
    );
    expect(toSpeechText("[Alice]: Hi Bob, how are you today?\n[Bob]: Fine, thanks. And you?")).toBe(
      "[Alice]: Hi Bob, how are you today?\n[Bob]: Fine, thanks. And you?",
    );
    expect(toSpeechText("[Note]: this is important.\n\n[ملاحظة]: هذا مهمّ جدًّا.")).toBe(
      "[Note]: this is important.\n[ملاحظة]: هذا مهمّ جدًّا.",
    );
    expect(toSpeechText("[00:15]: The speaker introduces the topic.")).toBe("[00:15]: The speaker introduces the topic.");
  });

  it("وتعريفُ مرجع الرابط بصيغته ما زال لا يُقرأ", () => {
    const md = "See [the docs][ref] and [more][r2].\n\n[ref]: https://example.com \"Docs\"\n[r2]: <https://example.com/a b> 'T'\n[r3]: https://x.y";
    expect(toSpeechText(md)).toBe("See the docs and more.");
  });

  /** ★ علامتا الضرب والقسمة وسطَ مدى الحروف اللاتينيّة — وهما رمزان */
  it("× و ÷ ليستا حرفين: سطرُ الحساب العربيّ لا يذهب إلى الصوت الإنجليزيّ", () => {
    expect(countScripts("× ÷")).toEqual({ arabic: 0, latin: 0, other: 0 });
    expect(countScripts("déjà vu Ærø")).toEqual({ arabic: 0, latin: 9, other: 0 });
    expect(detectSpeechLanguage("٥ × ٦", "ar")).toBe("ar");
    expect(chunkSpeechText("جدول الضرب:\n٧ × ٨ = ٥٦.\n12 ÷ 4 = 3.")).toEqual([
      { text: "جدول الضرب: ٧ × ٨ = ٥٦. 12 ÷ 4 = 3.", lang: "ar" },
    ]);
    expect(chunkSpeechText("The totals follow.\n5 × 6 = 30.")).toEqual([{ text: "The totals follow. 5 × 6 = 30.", lang: "en" }]);
  });

  /** ★ «a<b then c>d»: معاملٌ اسمُه كاسم وسمٍ لا يجعل المقارنةَ وسمًا */
  it("مقارنةٌ معاملُها يشبه اسمَ وسم تبقى كاملة", () => {
    expect(toSpeechText("If a<b then return a, else if a>b then return b.")).toBe(
      "If a<b then return a, else if a>b then return b.",
    );
    expect(toSpeechText("if a<b then c>d.")).toBe("if a<b then c>d.");
    expect(toSpeechText("إذا كان a<b و c>d فإن الشرط متحقّق.")).toBe("إذا كان a<b و c>d فإن الشرط متحقّق.");
    expect(toSpeechText("when count<code and code>limit we stop; total<table size and x>y.")).toBe(
      "when count<code and code>limit we stop; total<table size and x>y.",
    );
  });

  it("والوسمُ بخصائصه بصيغتها ما زال يُزال", () => {
    expect(
      toSpeechText('a <span class="x">b</span> c <img src="x.png" alt="y"/> d<br/>e <details open><summary>S</summary>t</details> <font color=red>f</font>'),
    ).toBe("a b c d e S t f.");
  });

  /** ★ «x**2» كانت تُقرأ «x2»: النجمةُ الملتصقةُ بحرفٍ لاتينيٍّ قبلها حسابٌ لا توكيد */
  it("نجمةٌ بين حروفٍ لاتينيّة أو بعد قوسٍ تبقى", () => {
    expect(toSpeechText("The derivative of x**2 is 2x. area = pi*r**2. E = m*c**2.")).toBe(
      "The derivative of x**2 is 2x. area = pi*r**2. E = m*c**2.",
    );
    expect(toSpeechText("The area is a*b and (a+b)*(a-b).")).toBe("The area is a*b and (a+b)*(a-b).");
    expect(toSpeechText("Required fields are marked with *.")).toBe("Required fields are marked with *.");
    expect(toSpeechText("Delete *.tmp files but keep *.md; pass *args and **kwargs.")).toBe(
      "Delete *.tmp files but keep *.md; pass *args and **kwargs.",
    );
  });

  it("والتوكيدُ بأشكاله ما زال يُزال — ومنه الملتصقُ بحرفٍ عربيّ قبله", () => {
    expect(toSpeechText("**bold**text, *a* *b*, 2 * 3 is *six*, **3 * 4** = 12, price: *5* dollars, ***both***.")).toBe(
      "boldtext, a b, 2 * 3 is six, 3 * 4 = 12, price: 5 dollars, both.",
    );
    expect(toSpeechText("و**كلمةٌ** بـ*خطٍّ* مائل، (*ملاحظة*)، - **مصطلح**: تعريفه.")).toBe(
      "وكلمةٌ بـخطٍّ مائل، (ملاحظة)، - مصطلح: تعريفه.",
    );
  });

  /** ★ الزوجُ لا يمتدّ فوق نجمةٍ بين طرفيه: فالمتداخلُ يُزال في جولتين */
  it("توكيدٌ داخل توكيد يُزال كلُّه", () => {
    expect(toSpeechText("**1. *Dune* by Frank Herbert (1965)**")).toBe("1. Dune by Frank Herbert (1965).");
    expect(toSpeechText("**ملاحظة: هذا *مهمّ* جدًّا.**")).toBe("ملاحظة: هذا مهمّ جدًّا.");
    expect(toSpeechText("**bold with *italic* inside** and *italic with **bold** inside*")).toBe(
      "bold with italic inside and italic with bold inside.",
    );
    expect(toSpeechText("- **Read *Clean Code* first**: it covers the basics.")).toBe("Read Clean Code first: it covers the basics.");
    expect(toSpeechText("**a** *b* **c *d* e** **f**")).toBe("a b c d e f.");
    // والحسابُ بجواره لا تمسّه الجولةُ الثانية
    expect(toSpeechText("2 ** 3 and **x *y* z** and a*b*c")).toBe("2 ** 3 and x y z and a*b*c.");
  });

  /**
   * ★ الغالقُ لا يكون بعد قوسٍ مغلقٍ وقبل حرفٍ أو رقم.
   *
   * نجمةٌ سائبة («*args»، «**kwargs») كانت تُقرَن بنجمة حسابٍ بعد قوس — وفي الجولة
   * الثانية ولو كان بينهما توكيدٌ صحيح. فيتبدّل الرقم: «len(a)2».
   */
  it("نجمةٌ سائبة لا تُقرَن بنجمة حسابٍ بعد قوس — ولو كان بينهما توكيد", () => {
    expect(toSpeechText("In Python, *args collects positional arguments. *Note:* len(a)*2 doubles the length.")).toBe(
      "In Python, *args collects positional arguments. Note: len(a)*2 doubles the length.",
    );
    expect(toSpeechText("**kwargs collects keyword arguments, *not* positional ones; use f(x)**2 for the square.")).toBe(
      "**kwargs collects keyword arguments, not positional ones; use f(x)**2 for the square.",
    );
    expect(toSpeechText("استخدم *args ثم *انتبه*: الناتج (س+ص)*٢ دائمًا.")).toBe("استخدم *args ثم انتبه: الناتج (س+ص)*٢ دائمًا.");
    expect(toSpeechText("In Python, *args collects positional arguments. len(a)*2 doubles the length.")).toBe(
      "In Python, *args collects positional arguments. len(a)*2 doubles the length.",
    );
    expect(toSpeechText("Matrix [m]*2 and set {s}*k stay.")).toBe("Matrix [m]*2 and set {s}*k stay.");
    // والتوكيدُ المختوم بقوسٍ ما زال يُزال: بعده فراغٌ أو علامةُ وقف، لا حرف
    expect(toSpeechText("**bold (x)** and *italic (y)* stay unwrapped; **bold (x)**, too.")).toBe(
      "bold (x) and italic (y) stay unwrapped; bold (x), too.",
    );
  });

  /** ★ قاعدةُ الفاتح بأشكالها: بعد حرفٍ لاتينيّ، وبعد رقمٍ (ومنه العربيّ)، وبعد قوس */
  it("الأسُّ والضربُ بعد حرفٍ أو رقمٍ أو قوس يبقيان", () => {
    for (const formula of ["x**2 + y**2 = z**2", "f(x)**2 + g(x)**2 = 1", "2*x + 3*y = 6", "2**n and 3**m", "٢*٣*٤ = ٢٤"]) {
      expect(toSpeechText(formula)).toBe(`${formula}.`);
    }
    expect(toSpeechText("**2*3 = 6**")).toBe("2*3 = 6.");
  });

  /** ★ كلُّ علامة ترقيمٍ هُربت تُقرأ بلا شرطتها — والشرطةُ قبل حرفٍ ليست هروبًا */
  it("السعرُ والنسبةُ المهروبان يُقرآن بلا الشرطة المائلة؛ ومسارُ الملفّ لا يُمسّ", () => {
    expect(
      toSpeechText("The price is \\$5 per user, so 20 users cost \\$100. That's a 15\\% discount compared with the old plan (\\$5.90)."),
    ).toBe("The price is $5 per user, so 20 users cost $100. That's a 15% discount compared with the old plan ($5.90).");
    expect(toSpeechText("السعر \\$50 والخصم 10\\% فقط.")).toBe("السعر $50 والخصم 10% فقط.");
    expect(toSpeechText("Open C:\\Users\\name and ask Tom \\& Ann.")).toBe("Open C:\\Users\\name and ask Tom & Ann.");
    // وما هُرب لا يدخل قاعدةً لاحقة: «^» ليست حاشيةً تُحذف، و«&» ليست كيانًا يُفكّ
    expect(toSpeechText("Write [\\^1] for a footnote marker and \\&amp; for the entity; Tom \\& Ann.")).toBe(
      "Write [^1] for a footnote marker and &amp; for the entity; Tom & Ann.",
    );
  });

  /** ★ تعريفُ المرجع لا يقطع فقرة؛ وما تلا عنوانًا ليس تتمّةَ فقرة */
  it("ما يشبه تعريفَ المرجع يُقرأ داخل الفقرة ويُحذف بعد العنوان", () => {
    expect(toSpeechText("Paragraph first\n[x]: y\nstill the paragraph.")).toBe("Paragraph first.\n[x]: y.\nstill the paragraph.");
    expect(toSpeechText("# Heading\n[x]: y\nText")).toBe("Heading.\nText.");
  });

  /** ★ الكودُ السطريّ لا تمسّه قاعدة: لا عنوانٌ يُحذف منه ولا كيانٌ يُفكّ ولا شرطةٌ تضيع */
  it("الكودُ السطريّ يُقرأ كما هو: شرطةٌ مائلة، وكياناتٌ، وعناوين، وتعبيرٌ نمطيّ", () => {
    expect(
      toSpeechText("On Windows the separator is `\\` while on Linux it is `/`; use `path.join(a, b)` and **never** concatenate `a_b` by hand."),
    ).toBe("On Windows the separator is \\ while on Linux it is /; use path.join(a, b) and never concatenate a_b by hand.");
    expect(toSpeechText("Write `&nbsp;` for a space, `&lt;` for less-than and `&amp;` for an ampersand.")).toBe(
      "Write &nbsp; for a space, &lt; for less-than and &amp; for an ampersand.",
    );
    expect(toSpeechText("Send a POST to `https://api.example.com/v1/users` and run `curl https://example.com/install.sh | sh`.")).toBe(
      "Send a POST to https://api.example.com/v1/users and run curl https://example.com/install.sh | sh.",
    );
    expect(toSpeechText("The pattern `\\d+\\.\\d*` and `\\[a-z\\]`.")).toBe("The pattern \\d+\\.\\d* and \\[a-z\\].");
  });

  /** ★ «grid[2][3]» كانت تُقرأ «grid[2]» — عنصرٌ غيرُ الذي في الرد */
  it("فهرسةٌ مزدوجة تبقى كاملة، واستشهادٌ بصيغة رابط يُحذف", () => {
    expect(toSpeechText("Set grid[2][3] to 1 and read rows[0][10].")).toBe("Set grid[2][3] to 1 and read rows[0][10].");
    expect(toSpeechText("m[1][2][3] and a[i][2] and a[2][j] and matrix[i][j].")).toBe(
      "m[1][2][3] and a[i][2] and a[2][j] and matrix[i][j].",
    );
    expect(toSpeechText("ثابتة[1] ومؤكَّدة [2][3]. Source: [[1]](https://a.b) and [[2]](https://c.d).")).toBe(
      "ثابتة ومؤكَّدة. Source: and.",
    );
  });

  it("عنوانٌ فيه `#` من كلامه: لا تُزال إلا العلاماتُ الخاتمة", () => {
    expect(toSpeechText("## الخلاصة ##\n# C# basics #\n## Use # here")).toBe("الخلاصة.\nC# basics.\nUse # here.");
  });

  it("جدولٌ فاصلُه شرطةٌ واحدة، وسطرٌ يبدأ كتلةً بعد الجدول، وقيمٌ مطلقة ليست جدولًا", () => {
    expect(toSpeechText("Name | Age\n:-: | :-:\nSara | 30\nOmar | 25")).toBe("Name, Age.\nSara, 30.\nOmar, 25.");
    expect(toSpeechText("| a | b |\n|---|---|\n| 1 | 2 |\n## Next | section\nplain text")).toBe(
      "a, b.\n1, 2.\nNext | section.\nplain text.",
    );
    expect(toSpeechText("| a | b |\n|---|---|\n| 1 | 2 |\n- item | with pipe")).toBe("a, b.\n1, 2.\nitem | with pipe.");
    expect(toSpeechText("|x| + |y| >= |x + y|")).toBe("|x| + |y| >= |x + y|.");
    expect(toSpeechText("a | b\n---\nafter")).toBe("a | b.\nafter.");
  });

  /**
   * ★ سياجٌ لم يُغلق داخل اقتباسٍ ينتهي بانتهائه، وكذلك ما فُتح على سطر علامة البند.
   *
   * وما فُتح على سطرٍ تالٍ من البند لا يُعرف له بند: فيبتلع ما بعده إلى آخر
   * الرد، كما في أعلى الرد. حدٌّ موثَّق في docs/browser-voice.md، ومثبَّتٌ هنا
   * ليكون تغييرُه قرارًا.
   */
  it("سياجٌ غيرُ مغلق: ينتهي بانتهاء الاقتباس أو بندٍ فُتح على سطر علامته؛ وغيرُ ذلك يبتلع ما بعده", () => {
    expect(toSpeechText(`> Example:\n> ${F}\n> code line\n\nParagraph after the quote.`)).toBe(
      "Example:\nParagraph after the quote.",
    );
    expect(toSpeechText(`1. ${F}bash\n   npm install\n2. Then run it.\n\nFinally, open the app.`)).toBe(
      "2. Then run it.\nFinally, open the app.",
    );
    expect(toSpeechText(`> ${F}js\n> const a = 1;\n${F}\nAfter the quote.`)).toBe("After the quote.");
    expect(toSpeechText(`شرح.\n${F}py\nprint(1)\nprint(2)`)).toBe("شرح.");
    expect(toSpeechText(`1. Run:\n   ${F}bash\n   npm i\n\nThen continue with the rest.`)).toBe("1. Run:");
  });

  /** ★ الإزاحةُ أعمدةٌ لا محارف: جسمُ سياجٍ مُزاحٌ بعلامة جدولة ما زال داخل بنده */
  it("سياجٌ على سطر علامة البند وجسمُه مُزاحٌ بعلامة جدولة: لا يُقرأ الكود ولا يضيع ما بعده", () => {
    expect(toSpeechText(`1. ${F}bash\n\tnpm install\n\t${F}\n2. Then run it.\n\nFinally, open the app.`)).toBe(
      "2. Then run it.\nFinally, open the app.",
    );
    expect(toSpeechText(`-\t${F}\n\tcode\n\t${F}\n- after`)).toBe("after.");
    // علامةُ الجدولة تبلغ مضاعفَ الأربعة التالي — لا ثلاثةَ أعمدة، ولا أربعةً فوق ما قبلها
    expect(toSpeechText(`1.  ${F}bash\n\tnpm install\n\t${F}\n2. Then run it.`)).toBe("2. Then run it.");
    expect(toSpeechText(`1.   ${F}bash\n \tnpm install\n2. Then run it.`)).toBe("npm install.\n2. Then run it.");
  });

  /** ★ علامةُ البند تُقاس بالأعمدة كما تُقاس أسطرُه: بندٌ متداخلٌ بعلامة جدولة لا يبتلع إخوتَه */
  it("سياجٌ غيرُ مغلق على سطر علامة بندٍ متداخلٍ بعلامة جدولة ينتهي ببنده، وإخوتُه تُقرأ", () => {
    expect(
      toSpeechText(`1. Install:\n\t- ${F}bash\n\t  npm install\n\t- Then start the server.\n\t- Open the page.\n2. Done.`),
    ).toBe("1. Install:\nThen start the server.\nOpen the page.\n2. Done.");
    expect(toSpeechText(`- A\n\t1. ${F}py\n\t   print(1)\n\t2. second step`)).toBe("A.\n2. second step.");
  });

  /** ★ الجملةُ بلا حروف تأخذ لغةَ **أوّل** جملةٍ ذاتِ حروفٍ بعدها على السطر — لا آخرِها، ولا مجاورتِها وحدَها */
  it("أرقامٌ متتالية أوّلَ السطر تأخذ لغةَ أوّل جملةٍ ذاتِ حروفٍ تليها", () => {
    expect(chunkSpeechText("تمهيدٌ عربيّ.\n1. 2. Install the package now. ثم شغّل البرنامج الآن.")).toEqual([
      { text: "تمهيدٌ عربيّ.", lang: "ar" },
      { text: "1. 2. Install the package now.", lang: "en" },
      { text: "ثم شغّل البرنامج الآن.", lang: "ar" },
    ]);
  });

  /** ★ رقمُ البند يُقرأ مع بنده لا بصوت الفقرة التي سبقته */
  it("رقمُ البند يأخذ لغةَ بنده", () => {
    expect(chunkSpeechText(toSpeechText("الخطوات:\n\n1. Install Node.js first\n2. Run npm install next"))).toEqual([
      { text: "الخطوات:", lang: "ar" },
      { text: "1. Install Node.js first. 2. Run npm install next.", lang: "en" },
    ]);
    expect(chunkSpeechText(toSpeechText("Follow these steps carefully please:\n\n1. افتح صفحة الإعدادات\n2. اضغط زرّ الحفظ"))).toEqual([
      { text: "Follow these steps carefully please:", lang: "en" },
      { text: "1. افتح صفحة الإعدادات. 2. اضغط زرّ الحفظ.", lang: "ar" },
    ]);
  });

  /** ★ ما يحمله النصُّ الواردُ من المنطقة الخاصّة يُنزع: لا يلتبس بحارسٍ ولا يخرج منه */
  it("محارفُ المنطقة الخاصّة في النصّ الوارد تُنزع ولا تتسرّب", () => {
    const pua = (code: number) => String.fromCharCode(code);
    const out = toSpeechText(`a${pua(0xe000)}b ${pua(0xe010)}0${pua(0xe011)} c *x* \`y\``);
    expect(out).toBe("ab 0 c x y.");
    for (const ch of out) {
      const code = ch.codePointAt(0)!;
      expect(code < 0xe000 || code > 0xf8ff).toBe(true);
    }
  });
});

describe("v150 — لغاتٌ لا صوتَ يصحّ لها هنا", () => {
  it("عدُّ الحروف بحسب الخطّ", () => {
    expect(countScripts("مرحبا hello 你好 123")).toEqual({ arabic: 5, latin: 5, other: 2 });
    expect(countScripts("١٢٣ ، ؟ 42")).toEqual({ arabic: 0, latin: 0, other: 0 });
  });

  /** ★ ردٌّ صينيٌّ بصوتٍ عربيّ هذيان — فلا يُعرض زرٌّ يَعِد به */
  it("ردٌّ غالبُه خطٌّ ثالث ⇒ لا يُقرأ", () => {
    expect(isSupportedSpeechLanguage("这是中文回复。请稍等。")).toBe(false);
    expect(isSupportedSpeechLanguage("Это ответ на русском языке.")).toBe(false);
  });

  it("العربيّةُ والإنجليزيّة والأرقامُ والنصُّ المختلط ⇒ يُقرأ", () => {
    expect(isSupportedSpeechLanguage("ردٌّ عربيّ")).toBe(true);
    expect(isSupportedSpeechLanguage("An English reply")).toBe(true);
    expect(isSupportedSpeechLanguage("2 + 2 = 4")).toBe(true);
    expect(isSupportedSpeechLanguage("كلمة 中 word")).toBe(true);
    expect(isSupportedSpeechLanguage("")).toBe(true);
  });

  /** ★ التعادلُ لا يكفي: نصفُ الحروف خطٌّ ثالث ⇒ لا يُقرأ */
  it("نصفُه خطٌّ ثالث ⇒ لا يُقرأ؛ وحرفٌ واحد منه لا يمنع", () => {
    expect(isSupportedSpeechLanguage("中文 ab")).toBe(false);
    expect(isSupportedSpeechLanguage("中文 abc")).toBe(true);
    expect(isSupportedSpeechLanguage("使用 React 的 useState 钩子来管理组件的状态，然后通过 useEffect 处理副作用。")).toBe(false);
  });

  /** حدٌّ معروف وموثَّق: الفارسيّةُ والأرديّة بخطٍّ عربيّ فتُعدّان عربيّة */
  it("لغةٌ بخطٍّ عربيّ غيرُ العربيّة تُعدّ عربيّة (حدٌّ موثَّق)", () => {
    expect(isSupportedSpeechLanguage("این یک پاسخ فارسی است.")).toBe(true);
    expect(detectSpeechLanguage("این یک پاسخ فارسی است.")).toBe("ar");
  });
});

describe("v150 — التقطيعُ إلى مقاطع", () => {
  it("جملٌ قصيرة بلغةٍ واحدة تُضمّ في مقطع", () => {
    const chunks = chunkSpeechText("الجملة الأولى. الجملة الثانية؟ الجملة الثالثة!");
    expect(chunks).toEqual([{ text: "الجملة الأولى. الجملة الثانية؟ الجملة الثالثة!", lang: "ar" }]);
  });

  it("لا مقطعَ يتجاوز الحدّ — ولا كلمةَ تضيع", () => {
    const sentence = "هذه جملةٌ متوسّطةُ الطول تُكرَّر لتملأ المقطع.";
    const text = Array.from({ length: 30 }, () => sentence).join(" ");
    const chunks = chunkSpeechText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunks.map((c) => c.text).join(" ")).toBe(text);
  });

  it("جملةٌ أطول من الحدّ تُقطع عند الفاصلة ثم عند الفراغ", () => {
    const long = `${"كلمة ".repeat(30)}، ${"لفظة ".repeat(30)}.`.replace(/\s+/g, " ");
    const chunks = chunkSpeechText(long, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(80);
    expect(chunks.map((c) => c.text).join(" ").replace(/\s+/g, " ")).toBe(long);
  });

  it("كلمةٌ واحدة أطول من الحدّ تُقطع قسرًا ولا يدور التقطيعُ بلا نهاية", () => {
    const chunks = chunkSpeechText("x".repeat(450), 100);
    expect(chunks.map((c) => c.text.length)).toEqual([100, 100, 100, 100, 50]);
  });

  /** ★ فقرةٌ إنجليزيّة في ردٍّ عربيّ تُقرأ بصوتها */
  it("لا تُضمّ جملتان بلغتين: لكلّ مقطعٍ لغتُه", () => {
    const chunks = chunkSpeechText("هذا شرحٌ بالعربيّة.\nThis part is in English.\nثم عودةٌ إلى العربيّة.");
    expect(chunks).toEqual([
      { text: "هذا شرحٌ بالعربيّة.", lang: "ar" },
      { text: "This part is in English.", lang: "en" },
      { text: "ثم عودةٌ إلى العربيّة.", lang: "ar" },
    ]);
  });

  it("سطرُ أرقامٍ يرث لغةَ ما قبله", () => {
    const chunks = chunkSpeechText("The totals follow.\n2024.\n1500.");
    expect(chunks).toEqual([{ text: "The totals follow. 2024. 1500.", lang: "en" }]);
  });

  it("الكسرُ العشريّ واسمُ النطاق لا يقطعان الجملة", () => {
    const chunks = chunkSpeechText("القيمة 3.14 تقريبًا وexample.com موقع. انتهى.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("القيمة 3.14 تقريبًا وexample.com موقع. انتهى.");
  });

  /** ★ جملةٌ طويلة مختلطة تُقطَّع: لكلّ جزءٍ لغتُه، لا لغةُ الجملة كلِّها */
  it("أجزاءُ الجملة الطويلة المختلطة: كلٌّ بلغته الغالبة", () => {
    const sentence = `${"كلمةٌ عربيّةٌ أخرى ".repeat(6)}، ${"another English word ".repeat(6)}.`;
    const chunks = chunkSpeechText(sentence, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.lang).toBe("ar");
    expect(chunks.at(-1)!.lang).toBe("en");
  });

  it("حدٌّ صغيرٌ أو غيرُ صحيح لا يدور بلا نهاية", () => {
    expect(chunkSpeechText("abc def", 1).map((c) => c.text).join("")).toBe("abcdef");
    expect(chunkSpeechText("abc def", 0).length).toBeGreaterThan(0);
    expect(chunkSpeechText("abc def", 2.7).every((c) => c.text.length <= 2)).toBe(true);
  });

  it("نصٌّ فارغ ⇒ لا مقاطع", () => {
    expect(chunkSpeechText("")).toEqual([]);
    expect(chunkSpeechText("\n \n")).toEqual([]);
  });

  it("ردٌّ طويلٌ جدًّا يُقطَّع كلُّه بلا اقتطاع", () => {
    const md = Array.from({ length: 400 }, (_, i) => `الفقرة رقم ${i} فيها معلومةٌ مفيدة.`).join("\n\n");
    const text = toSpeechText(md);
    const chunks = chunkSpeechText(text);
    expect(chunks.map((c) => c.text).join(" ")).toBe(text.split("\n").join(" "));
    expect(chunks.at(-1)!.text.endsWith("الفقرة رقم 399 فيها معلومةٌ مفيدة.")).toBe(true);
  });
});

describe("v150 — اختيارُ الصوت", () => {
  it("وسمُ اللغة يُوحَّد: شرطةٌ سفليّة وحالةُ الأحرف", () => {
    expect(normalizeLangTag("ar_SA")).toBe("ar-sa");
    expect(normalizeLangTag(" EN-us ")).toBe("en-us");
  });

  /** ★ `ar-SA` أوّلًا — ولو تأخّر في القائمة */
  it("العربيّة: ar-SA قبل غيرها", () => {
    const pick = pickVoice([EN_US, AR_EG, AR_SA], "ar");
    expect(pick?.voice).toBe(AR_SA);
    expect(pick?.langTag).toBe("ar-SA");
    expect(pick?.network).toBe(false);
  });

  it("العربيّة: بلا ar-SA يُؤخذ أيُّ صوتٍ عربيّ", () => {
    expect(pickVoice([EN_US, AR_EG], "ar")?.voice).toBe(AR_EG);
    const bare = voice("Arabic", "ar");
    expect(pickVoice([EN_US, bare], "ar")?.voice).toBe(bare);
  });

  it("الإنجليزيّة: en-US ثم en-GB ثم غيرهما", () => {
    const au = voice("English AU", "en-AU");
    expect(pickVoice([au, EN_GB, EN_US], "en")?.voice).toBe(EN_US);
    expect(pickVoice([au, EN_GB], "en")?.voice).toBe(EN_GB);
    expect(pickVoice([au], "en")?.voice).toBe(au);
  });

  /** ★ الصوتُ الخطأ أسوأ من لا صوت */
  it("لا صوتَ للّغة ⇒ null — لا يُعطى النصُّ العربيُّ صوتًا إنجليزيًّا", () => {
    expect(pickVoice([EN_US, EN_GB], "ar")).toBeNull();
    expect(pickVoice([AR_SA], "en")).toBeNull();
    expect(pickVoice([], "ar")).toBeNull();
  });

  it("لغةٌ تبدأ بالحرفين نفسَيهما ليست هي: `arz` و`eng` لا تُطابقان بالخطأ", () => {
    expect(pickVoice([voice("Other", "arz-EG")], "ar")).toBeNull();
    expect(pickVoice([voice("Other", "enm")], "en")).toBeNull();
  });

  it("وسمُ أندرويد بالشرطة السفليّة يُطابَق ويُكتب بشرطة", () => {
    const android = voice("Android Arabic", "ar_SA");
    const pick = pickVoice([android], "ar");
    expect(pick?.voice).toBe(android);
    expect(pick?.langTag).toBe("ar-SA");
  });

  /** ★ ما قيل إنّه على الجهاز يسبق ما يُقدَّم عبر الشبكة — ولو كان الثاني ar-SA */
  it("صوتُ الجهاز يسبق صوتَ الشبكة", () => {
    const online = voice("Online Saudi", "ar-SA", { network: true });
    expect(pickVoice([online, AR_EG], "ar")?.voice).toBe(AR_EG);
    expect(pickVoice([online, AR_SA], "ar")?.voice).toBe(AR_SA);
  });

  it("وبين صوتَي شبكةٍ تُقدَّم اللهجةُ المفضَّلة", () => {
    const onlineEg = voice("Online Egypt", "ar-EG", { network: true });
    const onlineSa = voice("Online Saudi", "ar-SA", { network: true });
    const pick = pickVoice([onlineEg, onlineSa], "ar");
    expect(pick?.voice).toBe(onlineSa);
    expect(pick?.network).toBe(true);
  });

  /** ★ السياسةُ سطرٌ واحد: بلا أصوات الشبكة يُعامل غيابُ صوت الجهاز كغياب الصوت */
  it("برفض أصوات الشبكة: صوتُ الشبكة وحدَه ⇒ null", () => {
    const online = voice("Online Saudi", "ar-SA", { network: true });
    expect(pickVoice([online], "ar", { allowNetwork: false })).toBeNull();
    expect(pickVoice([online, AR_EG], "ar", { allowNetwork: false })?.voice).toBe(AR_EG);
    expect(pickVoice([online], "ar", { allowNetwork: true })?.voice).toBe(online);
  });

  /**
   * ★ المجهولُ يُعامل بالأحوط: `true` وحدَها تأكيدٌ أنّ الصوت من أصوات الجهاز.
   *
   * كان غيابُ `localService` يُعدّ «على الجهاز»: فصوتٌ لا يُعرف مصدرُه يُقرأ به
   * بلا سؤالٍ ولا ملاحظة. والآن يُؤخَّر في الترتيب، ويُعلَّم، ويُستبعد حين
   * تُطلب أصواتُ الجهاز وحدَها.
   */
  it("صوتٌ لا يذكر المتصفّحُ مصدرَه ليس من أصوات الجهاز: يُؤخَّر، ويُعلَّم، ويُستبعد بالرفض", () => {
    const unreported = voice("Unreported", "ar-SA", { unreported: true });
    expect("localService" in unreported).toBe(false);
    expect(isReportedDeviceVoice(unreported)).toBe(false);
    expect(isReportedDeviceVoice(AR_EG)).toBe(true);
    expect(isReportedDeviceVoice(voice("Online", "ar-SA", { network: true }))).toBe(false);
    // يُؤخَّر عن صوت الجهاز ولو كانت لهجتُه هي المفضَّلة
    expect(pickVoice([unreported, AR_EG], "ar")?.voice).toBe(AR_EG);
    expect(pickVoice([unreported, AR_EG], "ar")?.network).toBe(false);
    // وحدَه: يُختار ويُعلَّم أنّه ليس من أصوات الجهاز
    expect(pickVoice([unreported], "ar", { allowNetwork: true })?.voice).toBe(unreported);
    expect(pickVoice([unreported], "ar", { allowNetwork: true })?.network).toBe(true);
    // وبأصوات الجهاز وحدَها: كأنّه غائب
    expect(pickVoice([unreported], "ar", { allowNetwork: false })).toBeNull();
    // وقيمةٌ ليست منطقيّة ليست تأكيدًا
    for (const odd of [null, "true", 1, 0, undefined]) {
      const strange = { name: "odd", lang: "ar-SA", localService: odd } as unknown as ReturnType<typeof voice>;
      expect(isReportedDeviceVoice(strange), String(odd)).toBe(false);
      expect(pickVoice([strange], "ar", { allowNetwork: false }), String(odd)).toBeNull();
      expect(pickVoice([strange], "ar", { allowNetwork: true })?.network, String(odd)).toBe(true);
    }
  });

  it("السياسةُ الافتراضيّة معلَنة، والافتراضُ بلا خيارٍ يتبعها", () => {
    const online = voice("Online Saudi", "ar-SA", { network: true });
    expect(typeof ALLOW_NETWORK_VOICES).toBe("boolean");
    expect(pickVoice([online], "ar") !== null).toBe(ALLOW_NETWORK_VOICES);
  });

  it("عند التساوي يُقدَّم الصوتُ الافتراضيّ ثم ترتيبُ القائمة", () => {
    const a = voice("A", "ar-SA");
    const b = voice("B", "ar-SA", { default: true });
    const c = voice("C", "ar-SA");
    expect(pickVoice([a, b, c], "ar")?.voice).toBe(b);
    expect(pickVoice([a, c], "ar")?.voice).toBe(a);
  });

  /** ★ قائمةُ الإنجليزيّة في بعض الأنظمة تبدأ بأصوات المؤثّرات أبجديًّا */
  it("صوتُ المؤثّرات يُؤخَّر عن الصوت المعتاد من اللهجة نفسِها — ولا يُمنع", () => {
    const albert = voice("Albert", "en-US");
    const samantha = voice("Samantha", "en-US");
    const daniel = voice("Daniel", "en-GB");
    expect(pickVoice([albert, voice("Bad News", "en-US"), daniel, samantha, voice("Zarvox", "en-US")], "en")?.voice).toBe(samantha);
    // اللهجةُ المفضَّلة تسبق: لا يُترك en-US كلُّه إلى en-GB لأجل اسم
    expect(pickVoice([albert, daniel], "en")?.voice).toBe(albert);
    expect(pickVoice([albert], "en")?.voice).toBe(albert);
  });

  it("صوتٌ بلا وسم لغة لا يُطابق ولا يرمي", () => {
    const broken = { name: "broken", localService: true } as unknown as ReturnType<typeof voice>;
    expect(() => pickVoice([broken], "ar")).not.toThrow();
    expect(pickVoice([broken], "ar")).toBeNull();
    expect(pickVoice([broken, AR_SA], "ar")?.voice).toBe(AR_SA);
  });

  it("الوسمُ الافتراضيّ حين لا تُعرف القائمة", () => {
    expect(DEFAULT_LANG_TAG).toEqual({ ar: "ar-SA", en: "en-US" });
  });
});

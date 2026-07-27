# The lecture-generation prompt

Paste the block below into ChatGPT / Claude / Gemini when you want a new lecture deck. It exists because of what we measured on 2026-07-26: lectures generated without it arrive **70–73% on-brand** and need a doctor pass; the rules here are the exact things that went wrong, turned into orders.

**Why each rule is in there** (don't delete them casually):

| Rule | What it prevents |
|---|---|
| Start at `<!DOCTYPE html>`, no ``` fence | A markdown fence forces quirks mode; the deck's `<style>` is parsed into `<body>` and then beats any theme applied later — fonts change, colors freeze (EVO-013). 3 of 4 real lectures had this. |
| Copy the `<style>` skeleton verbatim | Its `:root` names (`--purple`, `--cyan`, `--bg-gray`…) are the **exact** names the app's MiM kit overrides. Same names = one click recolors the whole deck. |
| Every color through `var()`, including SVG | Kits recolor variables. A literal hex is unreachable by any theme — that was 110–138 literals per lecture. |
| Approved palette only, no gold | `#C5A059` is not a ministry color and never was. Neither is a per-lecture green cover. |
| No `@import` from fonts.googleapis.com | The deck then needs the internet to look right; offline it silently falls back. |
| Never pink or gold text on purple | 2.16:1 contrast — fails WCAG, and it's the single most common thing the doctor has to repair. |
| Lyon for headings, Diodrum for body, nothing on SVG | MiM assigns type by role (guide pp.21–23). A deck that names one family everywhere gets that one face everywhere, so headlines silently lose Lyon. |

Anything that still slips through is caught by the app: open the deck → **MiM** → **🩺 الفحص** → **«إصلاح الكل»**.

---

## The prompt (copy everything inside the fence)

````text
You are producing a university lecture as a single self-contained HTML slide deck, in Arabic (RTL), for the Saudi Ministry of Industry and Mineral Resources (MiM) visual identity.

## OUTPUT FORMAT — violating any of these makes the file unusable
1. Output ONLY the HTML file. No explanation before or after it.
2. Do NOT wrap the output in a markdown code fence. The very first characters of your reply must be `<!DOCTYPE html>` and the last must be `</html>`. Any text before the doctype silently breaks the file's styling.
3. One file, self-contained. No external CSS, no external JS, no `@import`, no `<link>` to any font host — the deck must look identical on a machine with no internet.

## STYLE BLOCK — copy this <head> verbatim, do not edit the values
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>[اسم الدرس]</title>
<style>
:root{
  --purple:#413258; --cyan:#1AD9C7; --pink:#BFA19F; --gold:#BFA19F;
  --dark:#1A1A1A; --bg-gray:#F4F4F6; --white:#FFFFFF;
  --grey-dark:#666666; --grey-mid:#B3B3B3; --grey-light:#E6E6E6;
}
body{margin:0;background:var(--bg-gray);font-family:'Diodrum Arabic','Cairo','Segoe UI',Tahoma,sans-serif;direction:rtl;}
.slide{width:950px;height:650px;margin:40px auto;background:var(--white);padding:45px 60px;position:relative;box-shadow:0 25px 50px rgba(0,0,0,.12);border-right:12px solid var(--purple);overflow:hidden;box-sizing:border-box;}
.slide h1{color:var(--purple);font-size:32px;margin:0 0 10px;border-bottom:3px solid var(--cyan);padding-bottom:8px;font-family:'Lyon Arabic Text','Diodrum Arabic','Cairo','Segoe UI',Tahoma,sans-serif;}
.slide h2{color:var(--dark);font-size:20px;margin:0 0 16px;font-weight:600;font-family:'Lyon Arabic Text','Diodrum Arabic','Cairo','Segoe UI',Tahoma,sans-serif;}
.content{font-size:17px;line-height:1.68;color:var(--dark);}
.cover-slide{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:var(--purple);}
.cover-slide h1{border:none;color:var(--white);font-size:38px;}
.cover-slide .kicker{color:var(--pink);font-size:16px;margin-bottom:14px;font-weight:600;}
.cover-slide .badge{display:inline-block;background:var(--pink);color:var(--dark);padding:10px 30px;border-radius:8px;font-weight:700;margin-top:18px;}
.box{background:var(--bg-gray);border-radius:8px;padding:16px 20px;margin:12px 0;}
.box-title{color:var(--purple);font-weight:700;margin-bottom:6px;}
table{width:100%;border-collapse:collapse;font-size:16px;}
th{background:var(--purple);color:var(--white);padding:10px;text-align:right;}
td{border:1px solid var(--grey-light);padding:9px;}
figure{margin:14px 0;text-align:center;}
figcaption{color:var(--grey-dark);font-size:14px;margin-top:6px;}
.footer{position:absolute;bottom:18px;left:60px;right:60px;color:var(--grey-dark);font-size:12px;display:flex;justify-content:space-between;}
</style>
</head>

## COLOR LAW — the whole point of the file
- Every color you write MUST be `var(--token)` using ONLY the tokens declared above. There must be ZERO literal colors (`#hex`, `rgb()`, or named colors like `red`) anywhere below the `:root` block — in CSS rules, in `style="…"` attributes, and inside SVG.
- SVG included: write `fill="var(--purple)"` and `stroke="var(--grey-light)"`, never `fill="#413258"`.
- Need a new style? Add a CSS rule that uses the existing tokens. Do NOT add new tokens and do NOT invent a color for this particular lecture — no gold, no green theme, no per-lesson palette. Every lecture in the course uses this same palette.
- Backgrounds: solid `var(--purple)` or `var(--bg-gray)`. If you want a gradient, use `linear-gradient(135deg, var(--white), var(--bg-gray))` — never hand-written color stops.
- Translucency is the one exception: `rgba(0,0,0,.12)` for shadows is fine.

## FONTS
- The two ministry typefaces are already named in the skeleton: **Lyon Arabic Text** for headings, **Diodrum Arabic** for body. Do not change those stacks and do not introduce any other family — no Cairo-only stacks, no Arial, no Times New Roman, no Georgia.
- Never write `font-family` on an SVG element. SVG text inherits the page font; `font-family="Arial"` on chart labels is the single most common way an otherwise-clean deck goes off-brand.
- Never add `@import` or a `<link>` for a font. The stacks above degrade gracefully on a machine that lacks the ministry files, and the editor embeds the real files when the identity is applied.

## READABILITY — checked automatically, so get it right the first time
- On `var(--purple)` or any dark background, text is `var(--white)`. NEVER `var(--pink)` or `var(--gold)` on purple — that is 2.16:1 and fails.
- On white or `var(--bg-gray)`, text is `var(--dark)`, `var(--purple)`, or `var(--grey-dark)`. Never `var(--cyan)` for body text on white (1.8:1) — cyan is for borders, rules, and accents only.
- Minimum body text 15px; footers may go to 12px. Nothing smaller.

## SLIDE STRUCTURE
- Each slide is `<div class="slide">`, exactly 950×650 with `overflow:hidden` — content that doesn't fit is CUT OFF, so keep each slide under ~110 Arabic words and never more than ~7 bullets.
- Slide 1 is `<div class="slide cover-slide">` with `.kicker`, `<h1>`, a one-line description, and a `.badge`.
- Every other slide opens with exactly one `<h1>`. Use `<h2>` for a subtitle, `.content` for the body, `.box` for callouts.
- Images go in `<figure>` with a `<figcaption>` caption written as «شكل N: …», numbered in order.
- Do not hardcode «شريحة N من M» in footers — slide counts change when the deck is edited.

## ARABIC
- Use natural academic Arabic. Reuse every technical term EXACTLY as it appears in the source material I give you — same spelling, same hamza forms (أ/إ/ء), same ة/ه and ى/ي. Do not re-translate, re-spell, or substitute synonyms for a term that already exists in the source.
- Give the English term in parentheses on first use only: «نموذج النقل (Transportation Model)».
- Pick ONE numeral system (Arabic-Indic ١٢٣ or Latin 123) and use it consistently in the entire file, including tables and charts.

## BEFORE YOU ANSWER — check your own output
1. Does the reply start with `<!DOCTYPE html>` with no fence and no preamble?
2. Search your HTML for `#` — the ONLY hex codes allowed are inside the `:root` block. Any other one is a bug; replace it with the right `var(--token)`.
3. Is there any `@import`, `<link>`, or `http` URL for fonts? Remove it.
4. Is any text pink, gold, or cyan on a purple or dark background? Change it to `var(--white)`.
5. Would any slide overflow 650px? Split it into two slides.

## THE LECTURE TO WRITE
[Paste your source material here, then state: the course name, the lesson number and title, and roughly how many slides you want.]
````

---

## After generating

The deck should already be on-brand. To be sure, open it in the Lecture Visual Editor and run **🩺 الفحص** — a clean deck reports zero cards. If anything did slip through, **«إصلاح الكل»** repairs it, and **MiM** applies the real ministry fonts (Lyon Arabic + Diodrum Arabic), which no prompt can embed for you.

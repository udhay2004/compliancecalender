// tests/page-safety.test.js
//
// The pages build HTML from data with template strings, so everything typed
// by a person (a contact name, an email, a file name, a chat message) goes
// through each page's own escaping helper first. Those values are also
// placed inside attributes (value="…", href="mailto:…", title="…"), where a
// quote ends the attribute: a helper that only escapes < > & lets a client
// whose contact name is  " autofocus onfocus="…  run script on the admin's
// screen. This suite runs every page's real helper against that.
//
//   node --test tests/

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PUBLIC = path.join(__dirname, "..", "public");
const files = [
  ...fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html")).map((f) => path.join(PUBLIC, f)),
  ...fs.readdirSync(path.join(PUBLIC, "js")).filter((f) => f.endsWith(".js")).map((f) => path.join(PUBLIC, "js", f)),
];

/** The source of `function <name>(…) {…}` from a page, by matching braces. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const helpers = [];
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  for (const name of ["escapeHtml", "esc"]) {
    const code = extractFunction(src, name);
    if (code) helpers.push({ file: path.relative(PUBLIC, file), name, code, src });
  }
}

test("every page that builds HTML from data has an escaping helper to test", () => {
  const names = helpers.map((h) => h.file).sort();
  for (const page of ["admin.html", "calendar.html", "dashboard.html", "index.html", "pipeline.html", "portal.html", "reports.html", "review.html"]) {
    assert.ok(names.includes(page), `${page} defines escapeHtml()/esc()`);
  }
});

test("each page's escaping helper neutralises tags AND quotes", () => {
  for (const h of helpers) {
    assert.ok(!/document\.createElement/.test(h.code), `${h.file}: ${h.name}() must not rely on innerHTML, which leaves quotes alone`);
    const fn = vm.runInNewContext(`(${h.code})`);
    const where = `${h.file} ${h.name}()`;
    assert.strictEqual(fn(`<img src=x onerror=alert(1)>`), "&lt;img src=x onerror=alert(1)&gt;", where);
    assert.strictEqual(fn(`Tom & "Jerry's" <Co>`), "Tom &amp; &quot;Jerry&#39;s&quot; &lt;Co&gt;", where);
    assert.strictEqual(fn(null), "", where);
    assert.strictEqual(fn(undefined), "", where);
    assert.strictEqual(fn(0), "0", where);
    assert.strictEqual(fn(12500), "12500", where);
    assert.strictEqual(fn("plain text, 100% fine"), "plain text, 100% fine", where);

    // The attack itself: a value dropped into an attribute can't end it.
    for (const evil of [`" autofocus onfocus="alert(document.domain)`, `a"onmouseover="alert(1)"@x.co`, `' onclick='alert(1)`, `"><script>alert(1)</script>`]) {
      const out = fn(evil);
      assert.ok(!/["'<>]/.test(out), `${where} left a quote or bracket in: ${out}`);
      const html = `<input value="${out}"><a href='mailto:${out}'>x</a>`;
      assert.strictEqual((html.match(/"/g) || []).length, 2, `${where}: the value="" attribute stayed closed`);
      assert.strictEqual((html.match(/'/g) || []).length, 2, `${where}: the href='' attribute stayed closed`);
    }
  }
});

test("no page puts a raw, unescaped field of a client or lead into an attribute", () => {
  // value="${x.something}" / href="${…}" without the helper, for the fields
  // people type themselves.
  const typed = /(companyName|contactName|primaryContact\w+|leadContact|fileName|requirementLabel|quoteNote|reviewNote|proofNote|senderName|\.email\b|\.phone\b|\.name\b|\.body\b|\.title\b)/;
  const problems = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/\b(value|href|title|placeholder|alt|data-[a-z-]+|aria-label)="[^"<>]*\$\{([^{}]+)\}/g)) {
      const expr = m[2].trim();
      if (/^(escapeHtml|esc|encodeURIComponent|safeLink|Number|parseInt|icon)\(/.test(expr)) continue;
      if (!typed.test(expr)) continue;
      problems.push(`${path.relative(PUBLIC, file)}:${src.slice(0, m.index).split("\n").length} ${m[1]}="\${${expr}}"`);
    }
  }
  assert.deepStrictEqual(problems, []);
});

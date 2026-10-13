// tests/email-check.test.js — lib/emailCheck.js: is the address typed on the
// public form one we can email the calendar to? DNS is replaced with a
// stand-in resolver; nothing here touches the network.
const test = require("node:test");
const assert = require("node:assert");

process.env.NODE_ENV = "test";
const { checkEmail, parse, acceptsMail } = require("../lib/emailCheck");

const dnsError = (code) => Object.assign(new Error(code), { code });
// domain -> what its DNS says
const ZONES = {
  "gmail.com": { mx: [{ exchange: "gmail-smtp-in.l.google.com", priority: 5 }] },
  "complyglobally.com": { mx: [{ exchange: "mx.zoho.in", priority: 10 }] },
  "example.com": { mx: [{ exchange: "", priority: 0 }] }, // null MX: takes no mail
  "a-record-only.io": { a: ["203.0.113.10"] },
  "v6-only.io": { aaaa: ["2001:db8::1"] },
  "parked-no-records.io": {},
};
const resolver = {
  async resolveMx(d) { const z = ZONES[d]; if (!z) throw dnsError("ENOTFOUND"); if (!z.mx) throw dnsError("ENODATA"); return z.mx; },
  async resolve4(d) { const z = ZONES[d]; if (!z) throw dnsError("ENOTFOUND"); if (!z.a) throw dnsError("ENODATA"); return z.a; },
  async resolve6(d) { const z = ZONES[d]; if (!z) throw dnsError("ENOTFOUND"); if (!z.aaaa) throw dnsError("ENODATA"); return z.aaaa; },
};
const check = (email) => checkEmail(email, { dns: resolver });

test("well-formed addresses are accepted and tidied; malformed ones are refused", async () => {
  assert.deepStrictEqual(await check("  Jane.Doe+tax@Gmail.com "), { ok: true, email: "jane.doe+tax@gmail.com" });
  assert.deepStrictEqual(await check("sales@complyglobally.com"), { ok: true, email: "sales@complyglobally.com" });
  const bad = ["", "   ", "plain", "@gmail.com", "a@", "a@b", "a@@gmail.com", "a b@gmail.com", "a@gmail .com", ".a@gmail.com", "a.@gmail.com",
    "a..b@gmail.com", "a@-gmail.com", "a@gmail-.com", "a@gmail..com", "a@gmail.c", "a@gmail.123", "a@gmail.com.", "<a@gmail.com>", "a@gmail.com,b@gmail.com",
    `${"x".repeat(65)}@gmail.com`, `a@${"x".repeat(250)}.com`, null, undefined, 42, {}, ["a@gmail.com"]];
  for (const b of bad) {
    const r = await check(b);
    assert.strictEqual(r.ok, false, `accepted ${JSON.stringify(b)}`);
    assert.match(r.error, /doesn't look like an email/);
  }
  assert.strictEqual(parse("a@b.co").domain, "b.co");
});

test("a mistyped provider is caught, with the address they meant", async () => {
  for (const [typed, meant] of [["jane@gmial.com", "jane@gmail.com"], ["Jane@GMAIL.con", "jane@gmail.com"], ["j@hotmial.com", "j@hotmail.com"], ["j@yahooo.com", "j@yahoo.com"], ["j@outlok.com", "j@outlook.com"]]) {
    const r = await check(typed);
    assert.strictEqual(r.ok, false, typed);
    assert.strictEqual(r.suggestion, meant);
    assert.ok(r.error.includes(meant));
  }
});

test("throwaway inboxes are refused", async () => {
  for (const e of ["x@mailinator.com", "x@YOPMAIL.com", "x@10minutemail.com"]) {
    const r = await check(e);
    assert.strictEqual(r.ok, false, e);
    assert.match(r.error, /regular email address/);
  }
});

test("the domain has to accept mail", async () => {
  assert.strictEqual((await check("a@a-record-only.io")).ok, true, "no MX: falls back to the address record");
  assert.strictEqual((await check("a@v6-only.io")).ok, true);
  for (const e of ["a@no-such-domain-anywhere.com", "a@example.com", "a@parked-no-records.io"]) {
    const r = await check(e);
    assert.strictEqual(r.ok, false, e);
    assert.match(r.error, /can't deliver email to/);
  }
});

test("DNS trouble never blocks a visitor", async () => {
  const broken = { resolveMx: async () => { throw dnsError("ECONNREFUSED"); }, resolve4: async () => { throw dnsError("ETIMEOUT"); }, resolve6: async () => { throw dnsError("ESERVFAIL"); } };
  assert.strictEqual(await acceptsMail("gmail.com", broken), null);
  assert.strictEqual((await checkEmail("a@whatever-domain.com", { dns: broken })).ok, true);
  assert.strictEqual((await checkEmail("a@whatever-domain.com", { dns: false })).ok, true, "the lookup can be switched off");
  // Typos and throwaway inboxes are still caught without DNS.
  assert.strictEqual((await checkEmail("a@gmial.com", { dns: broken })).ok, false);
});

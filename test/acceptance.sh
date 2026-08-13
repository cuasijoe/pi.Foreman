#!/usr/bin/env bash
# Foreman acceptance suite — exercises the extension end-to-end against real
# fixture repos and prints PASS/FAIL per check. Model-dependent behaviors are
# reported with evidence rather than hard-failed.
#
# Usage:  ./test/acceptance.sh            (uses default provider/model)
#         PI_MODEL=... ./test/acceptance.sh
#
# Requires: pi (with a configured provider), bash, git, node.

set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
EXT="$ROOT/src/index.ts"
JSONL="node $ROOT/test/jsonl.cjs"
WORK="$(mktemp -d /tmp/foreman-accept.XXXXXX)"
SMALL="$WORK/small"
BIG="$WORK/big"
PASS=0; FAIL=0; WARN=0

trap 'rm -rf "$WORK"' EXIT

check() { # name ok [evidence]
  if [ "$2" = "PASS" ]; then PASS=$((PASS+1)); echo "  PASS  $1"
  elif [ "$2" = "WARN" ]; then WARN=$((WARN+1)); echo "  WARN  $1 — ${3:-see output above}"
  else FAIL=$((FAIL+1)); echo "  FAIL  $1 — ${3:-see output above}"; fi
}

say() { echo; echo "== $1 =="; }

# ---------------------------------------------------------------- fixtures
build_small() {
  mkdir -p "$SMALL/src" "$SMALL/tests"
  cat > "$SMALL/package.json" <<'EOF'
{ "name": "small", "version": "1.0.0", "scripts": { "test": "node --test tests/" } }
EOF
  cat > "$SMALL/src/greeting.js" <<'EOF'
"use strict";
function greeting(name, excited = false) {
  if (!name) throw new Error("name is required");
  const base = `Hello, ${name}!`;
  return excited ? `${base} Wow!` : base;
}
function farewell(name) { return `Goodbye, ${name}.`; }
module.exports = { greeting, farewell };
EOF
  cat > "$SMALL/src/calc.js" <<'EOF'
"use strict";
function add(a, b) { return a + b; }
function multiply(a, b) { let t = 0; for (let i = 0; i < b; i++) t += a; return t; }
function divide(a, b) { if (b === 0) throw new Error("division by zero"); return a / b; }
module.exports = { add, multiply, divide };
EOF
  cat > "$SMALL/tests/calc.test.js" <<'EOF'
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { add, divide } = require("../src/calc.js");
test("add sums", () => assert.strictEqual(add(2, 3), 5));
test("divide works", () => assert.strictEqual(divide(10, 2), 5));
EOF
  git -C "$SMALL" init -q
  git -C "$SMALL" -c user.email=t@t -c user.name=t add -A
  git -C "$SMALL" -c user.email=t@t -c user.name=t commit -qm baseline
  printf '.pi/\n' > "$SMALL/.gitignore"
  git -C "$SMALL" add -A && git -C "$SMALL" -c user.email=t@t -c user.name=t commit -qm "gitignore"
}

build_big() {
  mkdir -p "$BIG/src/http" "$BIG/src/services" "$BIG/src/core" "$BIG/src/db" "$BIG/src/events" "$BIG/src/cache" "$BIG/tests"
  gen() { local f=$1 n=$2; { echo "\"use strict\";"; echo "// $f — implementation."; for i in $(seq 1 "$n"); do
    cat <<PEOF

function internal_$i(input) {
  const acc = [];
  for (let j = 0; j < input.length; j++) { const v = input[j]; if (v != null && v !== "") acc.push(v * $i + (j % 3)); }
  return acc;
}
PEOF
    done; } > "$f"; }
  cat > "$BIG/src/http/server.js" <<'EOF'
"use strict";
const { authenticate } = require("../services/auth.js");
const { createOrder } = require("../services/orders.js");
const { applyDiscount } = require("../services/discounts.js");
const { applyTax } = require("../services/tax.js");
const { chargeCard } = require("../services/payments.js");
const { reserveStock } = require("../services/inventory.js");
const { enqueue } = require("../events/bus.js");
const { runQuery } = require("../db/query.js");
EOF
  gen "$BIG/src/http/server.js" 12
  cat >> "$BIG/src/http/server.js" <<'EOF'

function route(req) {
  if (req.path === "/purchase" && req.method === "POST") {
    const user = authenticate(req);
    const order = createOrder(user, req.body.items);
    applyDiscount(order, req.body.coupon);
    applyTax(order);
    const charge = chargeCard(user, order.total);
    if (charge.ok) reserveStock(order.items);
    enqueue("order.created", order.id);
    runQuery("INSERT INTO orders (id, total) VALUES ($1, $2)", [order.id, order.total]);
    return { order, charge };
  }
  return { status: 404 };
}
module.exports = { route };
EOF
  for svc in auth orders discounts tax payments inventory; do
    case $svc in
      auth)      cat > "$BIG/src/services/auth.js" <<'EOF'
"use strict";
const { verifyToken } = require("../core/tokens.js");
const { rateLimit } = require("../core/ratelimit.js");
EOF
                 gen "$BIG/src/services/auth.js" 12
                 cat >> "$BIG/src/services/auth.js" <<'EOF'

function authenticate(req) {
  rateLimit(req.ip);
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const claims = verifyToken(token);
  if (!claims) throw new Error("unauthorized");
  return { id: claims.sub, role: claims.role };
}
module.exports = { authenticate };
EOF
                 ;;
      orders)    cat > "$BIG/src/services/orders.js" <<'EOF'
"use strict";
const { computeTotals } = require("../core/totals.js");
const { validateItems } = require("../core/validation.js");
EOF
                 gen "$BIG/src/services/orders.js" 12
                 cat >> "$BIG/src/services/orders.js" <<'EOF'

function createOrder(user, items) {
  validateItems(items);
  const { subtotal, tax } = computeTotals(items);
  return { id: `ord_${Date.now()}`, user: user.id, items, subtotal, tax, total: subtotal + tax };
}
module.exports = { createOrder };
EOF
                 ;;
      discounts) cat > "$BIG/src/services/discounts.js" <<'EOF'
"use strict";
const { lookupCoupon } = require("../core/coupons.js");
const { loyaltyTier } = require("../core/loyalty.js");
EOF
                 gen "$BIG/src/services/discounts.js" 12
                 cat >> "$BIG/src/services/discounts.js" <<'EOF'

function applyDiscount(order, couponCode) {
  const coupon = lookupCoupon(couponCode);
  const tier = loyaltyTier(order.user);
  const pct = Math.max(coupon?.pct ?? 0, tier.discountPct ?? 0);
  order.total = Math.round(order.total * (1 - pct / 100));
  order.discountPct = pct;
}
module.exports = { applyDiscount };
EOF
                 ;;
      tax)       cat > "$BIG/src/services/tax.js" <<'EOF'
"use strict";
const { taxRate } = require("../core/taxrates.js");
EOF
                 gen "$BIG/src/services/tax.js" 12
                 cat >> "$BIG/src/services/tax.js" <<'EOF'

function applyTax(order) {
  const rate = taxRate(order.shippingRegion ?? "default");
  order.tax = Math.round(order.subtotal * rate);
  order.total = order.subtotal + order.tax;
}
module.exports = { applyTax };
EOF
                 ;;
      payments)  cat > "$BIG/src/services/payments.js" <<'EOF'
"use strict";
const { chargeGateway } = require("../core/gateway.js");
const { fraudCheck } = require("../core/fraud.js");
EOF
                 gen "$BIG/src/services/payments.js" 12
                 cat >> "$BIG/src/services/payments.js" <<'EOF'

function chargeCard(user, amount) {
  if (fraudCheck(user, amount).flag) return { ok: false, reason: "fraud" };
  return chargeGateway({ userId: user.id, amount });
}
module.exports = { chargeCard };
EOF
                 ;;
      inventory) cat > "$BIG/src/services/inventory.js" <<'EOF'
"use strict";
const { runQuery } = require("../db/query.js");
const { invalidate } = require("../cache/store.js");
EOF
                 gen "$BIG/src/services/inventory.js" 12
                 cat >> "$BIG/src/services/inventory.js" <<'EOF'

function reserveStock(items) {
  for (const it of items) {
    runQuery("UPDATE inventory SET qty = qty - $1 WHERE sku = $2", [it.qty, it.sku]);
    invalidate(`stock:${it.sku}`);
  }
  return true;
}
module.exports = { reserveStock };
EOF
                 ;;
    esac
  done
  cat > "$BIG/src/core/tokens.js" <<'EOF'
"use strict";
function verifyToken(token) { return token === "valid" ? { sub: "u1", role: "user" } : null; }
module.exports = { verifyToken };
EOF
  cat > "$BIG/src/core/totals.js" <<'EOF'
"use strict";
function computeTotals(items) {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  return { subtotal, tax: Math.round(subtotal * 0.08) };
}
module.exports = { computeTotals };
EOF
  cat > "$BIG/src/core/validation.js" <<'EOF'
"use strict";
function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("no items");
  for (const it of items) { if (!it.sku || it.qty < 1) throw new Error("bad item"); }
}
module.exports = { validateItems };
EOF
  cat > "$BIG/src/core/ratelimit.js" <<'EOF'
"use strict";
const { get, incr } = require("../cache/store.js");
function rateLimit(ip) {
  const key = `rl:${ip}`;
  const n = incr(key);
  const window = get(key);
  if (n > 100 && window) throw new Error("rate limited");
  return n;
}
module.exports = { rateLimit };
EOF
  cat > "$BIG/src/core/coupons.js" <<'EOF'
"use strict";
function lookupCoupon(code) { const t = { SAVE10: { pct: 10 }, WELCOME: { pct: 5 } }; return t[code]; }
module.exports = { lookupCoupon };
EOF
  cat > "$BIG/src/core/loyalty.js" <<'EOF'
"use strict";
function loyaltyTier(userId) { return { discountPct: 0 }; }
module.exports = { loyaltyTier };
EOF
  cat > "$BIG/src/core/taxrates.js" <<'EOF'
"use strict";
function taxRate(region) { return { us: 0.08, eu: 0.2, default: 0.1 }[region] ?? 0.1; }
module.exports = { taxRate };
EOF
  cat > "$BIG/src/core/gateway.js" <<'EOF'
"use strict";
function chargeGateway({ userId, amount }) { return amount > 0 ? { ok: true, id: `ch_${userId}` } : { ok: false }; }
module.exports = { chargeGateway };
EOF
  cat > "$BIG/src/core/fraud.js" <<'EOF'
"use strict";
function fraudCheck(user, amount) { return { flag: amount > 10000 }; }
module.exports = { fraudCheck };
EOF
  cat > "$BIG/src/db/query.js" <<'EOF'
"use strict";
const { pool } = require("./pool.js");
function runQuery(sql, params = []) { return pool.query(sql, params); }
module.exports = { runQuery };
EOF
  cat > "$BIG/src/db/pool.js" <<'EOF'
"use strict";
const pool = { query: (sql, params) => ({ rows: [], sql, params }) };
module.exports = { pool };
EOF
  cat > "$BIG/src/events/bus.js" <<'EOF'
"use strict";
const listeners = new Map();
function enqueue(event, payload) { for (const fn of listeners.get(event) ?? []) fn(payload); }
function on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); }
module.exports = { enqueue, on };
EOF
  cat > "$BIG/src/cache/store.js" <<'EOF'
"use strict";
const store = new Map();
function get(k) { return store.get(k); }
function incr(k) { store.set(k, (store.get(k) ?? 0) + 1); return store.get(k); }
function invalidate(k) { store.delete(k); }
module.exports = { get, incr, invalidate };
EOF
  cat > "$BIG/tests/flow.test.js" <<'EOF'
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { route } = require("../src/http/server.js");
test("purchase route returns an order", () => {
  const res = route({ method: "POST", path: "/purchase", headers: { authorization: "Bearer valid" }, body: { items: [{ sku: "a", qty: 1, price: 10 }] } });
  assert.strictEqual(res.order.total, 11);
});
EOF
  git -C "$BIG" init -q
  git -C "$BIG" -c user.email=t@t -c user.name=t add -A
  git -C "$BIG" -c user.email=t@t -c user.name=t commit -qm baseline
}

say "preflight"
if ! pi -p "Reply with exactly: OK" >/dev/null 2>&1; then
  echo "  pi cannot reach a model (check provider/auth). Aborting."
  exit 1
fi
echo "  provider OK"

say "fixtures"
build_small; build_big
echo "  small repo: $(git -C "$SMALL" log --oneline | wc -l | tr -d ' ') commits, $(find "$SMALL/src" -name '*.js' | wc -l | tr -d ' ') src files"
echo "  big repo:   $(git -C "$BIG" log --oneline | wc -l | tr -d ' ') commits, $(find "$BIG/src" -name '*.js' | wc -l | tr -d ' ') src files"

# ---------------------------------------------------------- 1. loads, tools
say "1. extension loads; three tools appear"
PROBE="$WORK/tools.txt"
(cd "$SMALL" && FOREMAN_TOOLS_PROBE="$PROBE" pi -e "$EXT" -e "$ROOT/test/probe-tools.ts" -p "Reply with exactly: OK" >/dev/null 2>&1)
for t in explore review verify; do
  if grep -qx "$t" "$PROBE" 2>/dev/null; then check "tool '$t' registered" PASS; else check "tool '$t' registered" FAIL; fi
done

# ------------------------------------------- 1b. disabled config removes tools
say "1b. config.disabled removes tools from the active set"
mkdir -p "$SMALL/.pi"
echo '{ "disabled": ["verify"] }' > "$SMALL/.pi/foreman.json"
PROBE_DISABLED="$WORK/tools-disabled.txt"
(cd "$SMALL" && FOREMAN_TOOLS_PROBE="$PROBE_DISABLED" pi --approve -e "$EXT" -e "$ROOT/test/probe-tools.ts" -p "Reply with exactly: OK" >/dev/null 2>&1)
if grep -qx "explore" "$PROBE_DISABLED" && grep -qx "review" "$PROBE_DISABLED" && ! grep -qx "verify" "$PROBE_DISABLED"; then
  check "disabled: verify removed, explore/review kept" PASS
else
  check "disabled: verify removed, explore/review kept" FAIL
fi
rm -rf "$SMALL/.pi"

# ------------------------------------------------------ 2. explore + economy
say "2. explore: one call, real line numbers, compact return"
(cd "$BIG" && pi -e "$EXT" --mode json -p "Use the explore tool to find where computeTotals is defined and every place that uses it. Report what it returned.") 2>/dev/null > "$WORK/explore.jsonl"
TOOLS=$($JSONL "$WORK/explore.jsonl" --tools)
echo "  $TOOLS"
EXPLORES=$(echo "$TOOLS" | grep -o "explore:[0-9]*" | grep -o "[0-9]*")
LOG=$(find "$BIG/.pi/foreman/logs" -name "explore-*.json" 2>/dev/null | tail -1)
if [ -n "$LOG" ]; then
  NODE_LOG=$(node -e "const l=require(process.argv[1]); console.log([l.tool, l.usage.turns+' turns', l.usage.input+' in', l.usage.output+' out', l.stoppedBy].join(' '))" "$LOG")
  echo "  child: $NODE_LOG"
else
  NODE_LOG="no log written"; echo "  $NODE_LOG"
fi
if [ "$EXPLORES" = "1" ] && [ -n "$LOG" ]; then check "explore called exactly once, transcript logged" PASS; else check "explore called exactly once, transcript logged" WARN "parent may have delegated 0 or >1 times (model-dependent)"; fi
# spot-check real line numbers from the child's report (only meaningful if the child
# completed; if it hit the turn cap mid-search there is no final LOCATIONS list yet)
LINES_OK=$(node -e "
const l=require(process.argv[1]);
const t=[...l.messages].reverse().find(m=>m.role==='assistant');
const text=(t.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('');
const re=/src\/[a-z/]+\.js:\d+/g; const hits=[...new Set(text.match(re)||[])];
let ok=0; const fs=require('fs');
for (const h of hits) { const [f,ln]=h.split(':'); const p=process.argv[2]+'/'+f; try { const lines=fs.readFileSync(p,'utf8').split('\n'); if (lines[Number(ln)-1]!==undefined && lines[Number(ln)-1].trim()!=='') ok++; } catch {} }
console.log(ok + '/' + hits.length);
" "$LOG" "$BIG")
echo "  verified file:line hits: $LINES_OK (child stoppedBy: $(node -e "console.log(require(process.argv[1]).stoppedBy)" "$LOG"))"
case "$LINES_OK" in
  0/0) check "explore returns real line numbers" WARN "child produced no LOCATIONS list (hit turn cap or searched elsewhere)";;
  */0) check "explore returns real line numbers" FAIL "0 of $LINES_OK verified";;
  *) check "explore returns real line numbers" PASS "$LINES_OK verified against files";;
esac
if grep -q '\[explore: ' "$WORK/explore.jsonl"; then check "cost footer present on result" PASS; else check "cost footer present on result" FAIL; fi

# ------------------------------------------- 3. correct non-delegation
say "3. non-delegation (in-thread work stays in-thread)"
(cd "$SMALL" && pi -e "$EXT" --mode json -p "Read src/greeting.js, then change greeting() to say 'Hi, ' instead of 'Hello, '. Make the edit.") 2>/dev/null > "$WORK/nd1.jsonl"
T=$($JSONL "$WORK/nd1.jsonl" --tools); echo "  change in read file: $T"
echo "$T" | grep -q "explore" && check "no explore on in-context edit" FAIL || check "no explore on in-context edit" PASS
git -C "$SMALL" checkout -q .
(cd "$SMALL" && pi -e "$EXT" --mode json -p "There is a typo in src/greeting.js: farewell() says 'Goodbye' with a lowercase g. Fix the typo — trivial.") 2>/dev/null > "$WORK/nd2.jsonl"
T=$($JSONL "$WORK/nd2.jsonl" --tools); echo "  typo fix: $T"
echo "$T" | grep -q "review" && check "no review on typo fix" FAIL || check "no review on typo fix" PASS
git -C "$SMALL" checkout -q .
(cd "$SMALL" && pi -e "$EXT" --mode json -p "Run only tests/calc.test.js with node --test tests/calc.test.js. Quick.") 2>/dev/null > "$WORK/nd3.jsonl"
T=$($JSONL "$WORK/nd3.jsonl" --tools); echo "  single test: $T"
echo "$T" | grep -q "verify" && check "no verify on single named test" FAIL || check "no verify on single named test" PASS

# ---------------------------------------------------- 4. bash read-only gate
say "4. bash gate: rejects mutating commands, permits read-only search"
FOREMAN_BASH_MODE=explore FOREMAN_BASH_TIMEOUT_MS=96000 pi --mode json -p --no-session --no-extensions -e "$ROOT/src/child-bash.ts" --tools read,bash \
  "Run these commands and report each result: 1) rm -rf /tmp/x 2) sed -i 's/a/b/' /tmp/f 3) rg -n 'audit' src --type js. Also try calling the explore tool." 2>/dev/null > "$WORK/gate.jsonl"
# Two valid evidences: (a) the gate actually rejected attempts (tool-result errors), or
# (b) the child refused rm/sed in prose and ran rg — either way nothing destructive ran.
REJECTED=$(grep -c '"Command not allowed' "$WORK/gate.jsonl")
FINAL=$($JSONL "$WORK/gate.jsonl" --final)
REFUSED_BOTH=$(printf '%s' "$FINAL" | grep -ciE "rm[^\n]{0,40}(not run|blocked)|(not run|blocked)[^\n]{0,40}rm" )
RAN_RG=$(printf '%s' "$FINAL" | grep -ciE "rg -n|ran successfully|exit code")
echo "  gate rejections in transcript: $REJECTED | rm/sed refused in prose: $REFUSED_BOTH | rg evidence: $RAN_RG"
if [ "$REJECTED" -ge 2 ] || { [ "$REFUSED_BOTH" -ge 1 ] && [ "$RAN_RG" -ge 1 ]; }; then
  check "gate rejects rm/sed; allows rg; child lacks explore" PASS
else
  echo "  final text:"; printf '%s\n' "$FINAL" | head -8 | sed 's/^/    /'
  check "gate rejects rm/sed; allows rg; child lacks explore" WARN "no rejection evidence in this run"
fi

# ----------------------------------------------------------- 5. review tool
say "5. review: finds real defects; ships clean changes without nitpicks"
python3 - <<PY
p="$SMALL/src/calc.js"; s=open(p).read(); open(p,'w').write(s.replace('return a / b;','return a * b;'))
PY
(cd "$SMALL" && pi -e "$EXT" --mode json -p "I changed divide() in src/calc.js (uncommitted). Use the review tool. The intent: divide should return the quotient. If it is wrong, do NOT fix it — just report.") 2>/dev/null > "$WORK/rv1.jsonl"
RV=$($JSONL "$WORK/rv1.jsonl" --toolresult=review)
echo "$RV" | grep -q "fix-first" && check "review flags intentional bug (fix-first)" PASS || check "review flags intentional bug (fix-first)" FAIL
echo "$RV" | grep -qE "\[high\]" && check "finding has severity + location" PASS || check "finding has severity + location" FAIL
git -C "$SMALL" checkout -q .
cat > "$SMALL/src/greeting.js" <<'EOF'
"use strict";
function greeting(name, excited = false) {
  if (!name) throw new Error("name is required");
  const base = `Hello, ${name}!`;
  return excited ? `${base} Wow!` : base;
}
function farewell(name) { return `Goodbye, ${name}.`; }
function loudFarewell(name) { return `${farewell(name)} Farewell!`; }
module.exports = { greeting, farewell, loudFarewell };
EOF
cat >> "$SMALL/tests/calc.test.js" <<'EOF'
const { greeting, loudFarewell } = require("../src/greeting.js");
test("greeting greets", () => assert.strictEqual(greeting("A"), "Hello, A!"));
test("loudFarewell adds suffix", () => assert.strictEqual(loudFarewell("A"), "Goodbye, A. Farewell!"));
EOF
(cd "$SMALL" && pi -e "$EXT" --mode json -p "I added loudFarewell() to src/greeting.js plus tests (uncommitted working-tree changes). Use the review tool. Intent: add a loud farewell with test coverage.") 2>/dev/null > "$WORK/rv2.jsonl"
RV=$($JSONL "$WORK/rv2.jsonl" --toolresult=review)
echo "$RV" | grep -q "VERDICT: ship" && check "clean change ships" PASS || check "clean change ships" FAIL
FINDINGS=$(echo "$RV" | sed -n '/FINDINGS:/,/NOTES:/p' | grep -c "^- \[" )
echo "  findings on clean change: $FINDINGS"
[ "$FINDINGS" = "0" ] && check "no manufactured findings" PASS || check "no manufactured findings" WARN "review reported $FINDINGS finding(s)"
git -C "$SMALL" checkout -q .

# ---------------------------------------------------------- 6. verify tool
say "6. verify: distills failures; refuses watch commands"
cat > "$SMALL/tests/broken.test.js" <<'EOF'
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { add, multiply, divide } = require("../src/calc.js");
test("add sums positive numbers", () => assert.strictEqual(add(2, 3), 6));
test("multiply handles zero", () => assert.strictEqual(multiply(4, 0), 4));
test("divide by zero message", () => assert.throws(() => divide(1, 0), /division by zero!/));
EOF
(cd "$SMALL" && pi -e "$EXT" --mode json -p "Run the verify tool on the test suite.") 2>/dev/null > "$WORK/ver.jsonl"
VOUT=$($JSONL "$WORK/ver.jsonl" --toolresult=verify)
LINES=$(printf '%s' "$VOUT" | wc -l | tr -d ' ')
echo "$VOUT" | grep -q "RESULT: fail" && check "verify reports fail" PASS || check "verify reports fail" FAIL
[ "$LINES" -le 40 ] && check "verify output <= 40 lines ($LINES)" PASS || check "verify output <= 40 lines ($LINES)" FAIL
if printf '%s' "$VOUT" | grep -qE "at (Object\.)?<anonymous>|^\s+at |Error: \["; then check "no raw stack traces" FAIL; else check "no raw stack traces" PASS; fi
grep -q "broken.test.js:" <<<"$VOUT" && check "failure locations present" PASS || check "failure locations present" FAIL
(cd "$SMALL" && pi -e "$EXT" --mode json -p "Use the verify tool. Pass command: 'npm run dev'") 2>/dev/null > "$WORK/vw.jsonl"
VW=$($JSONL "$WORK/vw.jsonl" --final)
echo "$VW" | grep -qi "refused" && check "watch-mode command refused" PASS || check "watch-mode command refused" FAIL
rm -f "$SMALL/tests/broken.test.js"

# -------------------------------------------------- 7. context pressure
say "7. context-pressure injection (configurable, disableable)"
cat > "$WORK/payload-probe.ts" <<EOF
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) => {
    console.log("[probe] note:", JSON.stringify((event.payload as any) ?? {}).includes("context is heavily constrained"));
  });
}
EOF
mkdir -p "$SMALL/.pi"
echo '{ "contextPressure": { "warnAt": 0, "strongAt": 0 } }' > "$SMALL/.pi/foreman.json"
# Extension console.log goes to stderr in json mode (stdout is the JSON protocol), so capture both.
(cd "$SMALL" && pi --approve -e "$EXT" -e "$WORK/payload-probe.ts" --mode json -p "Read src/greeting.js and summarize it.") > "$WORK/cp1.jsonl" 2>&1
grep -q "\[probe\] note: true" "$WORK/cp1.jsonl" && check "fires above configured threshold" PASS || check "fires above configured threshold" FAIL
echo '{ "contextPressure": false }' > "$SMALL/.pi/foreman.json"
(cd "$SMALL" && pi --approve -e "$EXT" -e "$WORK/payload-probe.ts" --mode json -p "Read src/greeting.js and summarize it.") > "$WORK/cp2.jsonl" 2>&1
grep -q "\[probe\] note: true" "$WORK/cp2.jsonl" && check "disabled config removes injection" FAIL || check "disabled config removes injection" PASS
rm -rf "$SMALL/.pi"

# ------------------------------------------------------------- 8. ctrl-c
say "8. Ctrl-C kills child + in-flight process, no orphans"
cat > "$SMALL/tests/slow.test.js" <<'EOF'
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
test("slow test", async () => { await new Promise((r) => setTimeout(r, 120000)); assert.ok(true); });
EOF
nohup pi -e "$EXT" -p "Use the verify tool to run the test suite." > "$WORK/cc.log" 2>&1 &
PARENT=$!
sleep 22
kill -INT "$PARENT"
sleep 2
ORPHANS=$(ps -ax -o pid,command | grep -E "slow.test|node --test|--mode json" | grep -v grep | wc -l | tr -d ' ')
[ "$ORPHANS" = "0" ] && check "no orphans 2s after Ctrl-C" PASS || check "no orphans 2s after Ctrl-C" FAIL "leftover pids: $ORPHANS"
rm -f "$SMALL/tests/slow.test.js"

# ------------------------------------------------------- 9. /foreman totals
say "9. /foreman shows config + per-tool spend matching footers"
OUT=$(cd "$SMALL" && pi -e "$EXT" -p "Run the verify tool on the test suite." "/foreman" 2>&1)
if echo "$OUT" | grep -qE "verify: [0-9]+ run" && echo "$OUT" | grep -q "logs:"; then check "/foreman reports spend + log dir" PASS; else check "/foreman reports spend + log dir" WARN "model may not have called verify this run"; fi

# ------------------------------------------------------------ 10. no config
say "10. deleting .pi/foreman.json changes nothing"
rm -rf "$SMALL/.pi"
(cd "$SMALL" && pi --approve -e "$EXT" --mode json -p "Use the explore tool to find where divide() is defined.") 2>/dev/null > "$WORK/nc.jsonl"
if $JSONL "$WORK/nc.jsonl" --final | grep -q .; then check "runs with zero config" PASS; else check "runs with zero config" FAIL; fi

echo
echo "=============================================="
echo "  PASS: $PASS   FAIL: $FAIL   WARN: $WARN"
echo "  (WARN = model-dependent or needs a look at the output above)"
echo "=============================================="

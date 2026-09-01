/**
 * 区分B（実キー・実ネットワークが要る確認）の実行ハーネス。
 *
 *   npm run verify:b
 *
 * このスクリプトは「実確認が通ったか」だけを見る。実装が終わったかは見ない。
 * - 動かせない段は理由（鍵が無い／到達できない／仕様が未確定）を並べて blocked にする。
 * - 実確認が通った段だけ、証拠レコードを config/verification-evidence.json に追記する。
 * - 偽の署名・偽のレスポンスは作らない。到達できない相手を「通った」ことにしない。
 *
 * 詳細と必要な入力は docs/verification-b-runbook.md。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const EVIDENCE_PATH = 'config/verification-evidence.json';
const REPORT_PATH = process.env.NA_VERIFY_REPORT ?? 'artifacts/verification-report.json';

const x402 = JSON.parse(readFileSync('config/x402.config.json', 'utf8'));
const identity = JSON.parse(readFileSync('config/identity.config.json', 'utf8'));
const privacy = JSON.parse(readFileSync('config/privacy.config.json', 'utf8'));

const env = process.env;
const solanaRail = x402.rails.find((r) => r.id === 'solana');
const baseRail = x402.rails.find((r) => r.id === 'base');

/**
 * 段の定義。requires が 1 つでも欠けたら run しない（推測で埋めない）。
 * spec は「記載が無いので実装できない」もの。鍵やネットワークが揃っても埋まらない。
 */
const STAGES = [
  {
    id: 'signing',
    title: '2. 実署名（Circle DCW / 生 keypair）',
    targets: ['identity.signers.aa-solana', 'identity.custodial_wallets.dcw-evm-base', 'identity.custodial_wallets.dcw-solana'],
    requires: {
      env: ['NA_WALLET_PRIVATE_KEY'],
      hosts: [],
      spec: [
        'X-PAYMENT の payload の形（Solana: 何に署名した何を載せるか）',
        'Base の署名方式（EIP-3009 / permit のどちらか）と chainId・verifyingContract',
        'Circle DCW の署名 API の呼び出し形',
      ],
    },
  },
  {
    id: 'settlement',
    title: '1. 実 facilitator 疎通と実レール着金',
    targets: ['x402.facilitator', 'x402.rails.solana', 'x402.rails.base'],
    requires: {
      env: [],
      hosts: [x402.facilitator.url],
      spec: ['402 を返す実リソースのエンドポイント（支払い先の資源が未指定）'],
      stages: ['signing'],
    },
  },
  {
    id: 'mxe',
    title: '3. 実 Arcium MXE 投入と実 RPC',
    targets: ['privacy.gateway'],
    requires: {
      env: ['NA_ARCIUM_CLUSTER_URL'],
      hosts: [],
      spec: ['MXE クラスタの URL と、検証回路の呼び出し形'],
    },
  },
  {
    id: 'identity',
    title: '4. 実 identity（ERC-8004 照会 / Circle DCW wallet 発行）',
    targets: ['identity.erc8004.base', 'identity.erc8004.arc-testnet'],
    requires: {
      env: [],
      hosts: [],
      spec: [
        'ERC-8004 レジストリのコントラクトアドレスと照会関数の ABI',
        'チェーン RPC エンドポイント（Base / Arc Testnet）',
        'Circle DCW の wallet 照会・発行 API の呼び出し形',
      ],
    },
  },
];

/**
 * 到達性の判定。
 * egress ゲートウェイが 403 を返すと「相手が答えた」ように見えるので、そこを分けて見る。
 * 相手が答えていないものを到達扱いにしない。
 */
async function reachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    const body = (await res.text().catch(() => '')).slice(0, 300).trim();
    if (res.status === 403 && /allowlist|egress|not allowed|forbidden by proxy/i.test(body)) {
      return { ok: false, detail: `egress ゲートウェイが拒否: ${body.slice(0, 140)}` };
    }
    if (res.status === 407) return { ok: false, detail: 'proxy 認証が要る（相手には届いていない）' };
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

function missingEnv(keys) {
  return keys.filter((key) => env[key] === undefined || env[key] === '');
}

async function evaluate(stage, done) {
  const blockers = [];
  for (const key of missingEnv(stage.requires.env ?? [])) blockers.push({ kind: 'env', detail: `${key} が未設定` });
  for (const host of stage.requires.hosts ?? []) {
    const result = await reachable(host);
    if (!result.ok) blockers.push({ kind: 'network', detail: `${host} に到達できない（${result.detail}）` });
  }
  for (const item of stage.requires.spec ?? []) blockers.push({ kind: 'spec', detail: `仕様が未確定: ${item}` });
  for (const dependency of stage.requires.stages ?? []) {
    if (!done.has(dependency)) blockers.push({ kind: 'order', detail: `先に ${dependency} を通す必要がある` });
  }
  return blockers;
}

/** 実確認が通った段だけが呼ぶ。証拠が無いなら呼ばない。 */
function appendEvidence(records) {
  if (records.length === 0) return 0;
  const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'));
  evidence.records.push(...records);
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  return records.length;
}

async function main() {
  console.log('[verify:b] 区分B の実確認ハーネス（実装完了では verified を上げない）');
  console.log(`[verify:b] facilitator: ${x402.facilitator.url}`);
  console.log(`[verify:b] payTo(solana): ${solanaRail.payTo} / asset: ${solanaRail.asset}`);
  console.log(`[verify:b] Base EIP-712 domain: name=${baseRail.eip712Domain.name} version=${baseRail.eip712Domain.version}`);
  console.log(
    `[verify:b] ERC-8004: ${identity.external_assets.erc8004.map((e) => `${e.chain}#${e.agentId}`).join(', ')}`,
  );
  console.log(`[verify:b] privacy gateway: ${privacy.gateway.url}`);
  console.log('');

  const done = new Set();
  const results = [];
  const newEvidence = [];

  for (const stage of STAGES) {
    const blockers = await evaluate(stage, done);
    if (blockers.length === 0) {
      // ここに来たら実行できる。実行結果から証拠を作る段を書く場所。
      // 現時点ではどの段もここへ到達しないため、実行本体は未実装のまま残す。
      results.push({ stage: stage.id, title: stage.title, status: 'ready', blockers: [], targets: stage.targets });
      console.log(`ready   ${stage.title}`);
      console.log('        要件は揃っている。実行本体は実環境で書き足す（このハーネスは証拠のみを記録する）');
      continue;
    }
    results.push({ stage: stage.id, title: stage.title, status: 'blocked', blockers, targets: stage.targets });
    console.log(`blocked ${stage.title}`);
    for (const blocker of blockers) console.log(`        [${blocker.kind}] ${blocker.detail}`);
  }

  const appended = appendEvidence(newEvidence);
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        environment: {
          note: 'このレポートは実行した環境の状態。到達性と鍵の有無はここでの観測値',
          outboundBlocked: results.some((r) => r.blockers.some((b) => b.kind === 'network')),
        },
        stages: results,
        evidenceAppended: appended,
        rule: 'verified:true は証拠レコードのある項目だけ。実装完了では上げない',
      },
      null,
      2,
    )}\n`,
  );

  console.log('');
  console.log(`[verify:b] レポート: ${REPORT_PATH}`);
  console.log(`[verify:b] 追記した証拠: ${appended} 件`);
  const blocked = results.filter((r) => r.status === 'blocked');
  if (blocked.length > 0) {
    console.log(`[verify:b] 未消化 ${blocked.length}/${results.length} 段。verified は false のまま`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

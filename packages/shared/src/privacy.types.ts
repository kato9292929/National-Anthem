import { arr, bool, obj, str } from './guards.js';

/** M5 privacy 層の config。 */
export interface PrivacyConfig {
  version: string;
  gateway: { url: string; confirmed: boolean; verified: boolean; source_repo: string };
  response: { allowedFields: string[]; confirmed: boolean };
  recording: { walletAddressesAllowed: boolean; amountsAllowed: boolean; endpointsAllowed: boolean };
  claims: { mixer: boolean; untraceability: boolean; claim_ja: string; confirmed: boolean };
}

export function validatePrivacyConfig(input: unknown, source: string): PrivacyConfig {
  const root = obj(input, source, '(root)');
  const gateway = obj(root['gateway'], source, 'gateway');
  const response = obj(root['response'], source, 'response');
  const recording = obj(root['recording'], source, 'recording');
  const claims = obj(root['claims'], source, 'claims');

  const allowedFields = arr(response['allowedFields'], source, 'response.allowedFields').map((v, i) =>
    str(v, source, `response.allowedFields[${i}]`),
  );
  if (allowedFields.length !== 1 || allowedFields[0] !== 'payment_valid') {
    throw new Error(`${source}: response.allowedFields は payment_valid のみ（実際: ${allowedFields.join(', ')}）`);
  }
  if (bool(recording['walletAddressesAllowed'], source, 'recording.walletAddressesAllowed')) {
    throw new Error(`${source}: ログ / KV にウォレットアドレスは残さない`);
  }
  if (bool(claims['mixer'], source, 'claims.mixer')) {
    throw new Error(`${source}: ミキサーは実装しない`);
  }
  if (bool(claims['untraceability'], source, 'claims.untraceability')) {
    throw new Error(`${source}: 追跡不能化は謳わない（検証の機密化であって送金の秘匿ではない）`);
  }

  return {
    version: str(root['version'], source, 'version'),
    gateway: {
      url: str(gateway['url'], source, 'gateway.url'),
      confirmed: bool(gateway['confirmed'], source, 'gateway.confirmed'),
      verified: bool(gateway['verified'], source, 'gateway.verified'),
      source_repo: str(gateway['source_repo'], source, 'gateway.source_repo'),
    },
    response: { allowedFields, confirmed: bool(response['confirmed'], source, 'response.confirmed') },
    recording: {
      walletAddressesAllowed: false,
      amountsAllowed: bool(recording['amountsAllowed'], source, 'recording.amountsAllowed'),
      endpointsAllowed: bool(recording['endpointsAllowed'], source, 'recording.endpointsAllowed'),
    },
    claims: {
      mixer: false,
      untraceability: false,
      claim_ja: str(claims['claim_ja'], source, 'claims.claim_ja'),
      confirmed: bool(claims['confirmed'], source, 'claims.confirmed'),
    },
  };
}

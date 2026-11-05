import sodium from 'libsodium-wrappers';

/**
 * Chiffre un secret pour l'API GitHub : boîte scellée libsodium
 * avec la clé publique du dépôt (base64), résultat en base64.
 */
export async function encryptSecret(publicKeyBase64: string, value: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

export interface SecretKeyPair {
  publicKey: string;
  privateKey: string;
}

/** Paire de clés pour les doublures et les tests (côté « GitHub »). */
export async function generateSecretKeyPair(): Promise<SecretKeyPair> {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
    privateKey: sodium.to_base64(pair.privateKey, sodium.base64_variants.ORIGINAL),
  };
}

/** Déchiffre une boîte scellée (utilisé par les doublures pour vérifier le chiffrement). */
export async function decryptSecret(pair: SecretKeyPair, encryptedBase64: string): Promise<string> {
  await sodium.ready;
  const opened = sodium.crypto_box_seal_open(
    sodium.from_base64(encryptedBase64, sodium.base64_variants.ORIGINAL),
    sodium.from_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
    sodium.from_base64(pair.privateKey, sodium.base64_variants.ORIGINAL),
  );
  return sodium.to_string(opened);
}

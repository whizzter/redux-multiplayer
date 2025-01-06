import path from "node:path";
import fs from "node:fs";
import { SerializedGenerationParams, UUIDGeneratorState } from "./sharedUUIDv7";
import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  RSAPSSKeyPairOptions,
} from "node:crypto";

export interface PEMCryptoKeyPair {
  publicKey: string;
  privateKey: string;
}

export const defaultLoadOrInitNodeKeypair = (opts?: {
  bits?: number;
  log?: (...args: any[]) => void;
}) => {
  const log = opts?.log ?? console.info;
  const keyPairFileName = path.join(
    (require.main as any).path,
    ".uuid_keypair"
  );
  log(
    "Redux multiplayer: Generating or loading keypair from ",
    keyPairFileName
  );
  const keyPairSrc = fs.existsSync(keyPairFileName)
    ? fs.readFileSync(keyPairFileName, "utf8")
    : null;
  const keyPair = keyPairSrc
    ? (JSON.parse(keyPairSrc) as PEMCryptoKeyPair)
    : generateDefaultKeyPair();

  if (!keyPairSrc) {
    log("Generated Keypair so store it to be pre-cached");
    fs.writeFileSync(keyPairFileName, JSON.stringify(keyPair), {
      encoding: "utf8",
    });
  } else {
    log("Loaded cached keypair!");
  }

  return keyPair;
};

/**
 * Create a keypair to use to use for UUID generation verification.
 *
 * @param bits Optional number of bits in the key, defaults to 4096 for "rsa" and "rsa-pss"
 * @param keyType The type of key to create, only "rsa" or "rsa-pss" currently.
 * @returns Returns a serializable keypair object.
 */
export const generateDefaultKeyPair = (
  bits?: number,
  keyType?: "rsa" | "rsa-pss"
) =>
  (keyType ?? "rsa") === "rsa"
    ? (generateKeyPairSync("rsa", {
        modulusLength: bits ?? 4096,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      } as RSAPSSKeyPairOptions<"pem", "pem">) as PEMCryptoKeyPair)
    : keyType === "rsa-pss"
      ? (generateKeyPairSync("rsa-pss", {
          modulusLength: bits ?? 4096,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        } as RSAPSSKeyPairOptions<"pem", "pem">) as PEMCryptoKeyPair)
      : (() => {
          throw new Error("Unknown algorithm:" + keyType);
        })();

/**
 * A gen-param context is used to create generation-states and verify their origin if passed from an outside source.
 * @param keyPair The public/private keypair used to create states for clients or verify incoming.
 * @returns a context object with the makeSigned and verify functions
 */
export const createGenParamContext = (keyPair: PEMCryptoKeyPair) => {
  const privKey = createPrivateKey(keyPair.privateKey);
  const pubKey = createPublicKey(keyPair.publicKey);
  const te = new TextEncoder();
  const signatureAlgo = "RSA-SHA256";

  return {
    /**
     * The makeSigned method is used on the server to create a generation context for clients.
     *
     * @param initBytesBase64 Optional base64 encoded random bytes (80 bytes of randomness is otherwise generated and base64 encoded for the output.)
     * @returns A serializaed generation-param object
     */
    makeSigned(initBytesBase64?: string) {
      if (!initBytesBase64) {
        // begin with pure random
        const initBytes = randomBytes(80);
        // encode the timestamp into the 6 first bytes.
        const timeStamp = Date.now();
        for (let i=0;i<6;i++) {
            initBytes[i] = 0xff&( timeStamp/Math.pow(256,5-i) );
        }
        // and make a base64 blob
        initBytesBase64 = initBytes.toString("base64");
      }

      const sign = createSign(signatureAlgo);
      const signature = sign.update(te.encode(initBytesBase64)).sign(privKey);

      const signatureBase64 = signature.toString("base64");

      return {
        initBytesBase64: initBytesBase64,
        signatureBase64,
      } as SerializedGenerationParams;
    },
    /**
     *
     * @param genParams Params as passed to the client or passed back on reconnection.
     * @returns
     */
    verify(genParams: SerializedGenerationParams) {
      const verify = createVerify(signatureAlgo);
      const signBuf = Buffer.from(genParams.signatureBase64, "base64");
      const verifyResult1 = verify
        .update(te.encode(genParams.initBytesBase64))
        .verify(pubKey, signBuf);
      return verifyResult1;
    },
  };
};

//export const verifySharedUUID7GenerationParams = ()

// export const testPK = () => {
//   const keyPair = createDefaultKeyPair();

//   console.log("Priv:", keyPair.privateKey);
//   console.log("Pub:", keyPair.publicKey);

//     const sign = createSign("RSA-SHA256");

//   const encData = Uint8Array.from("hello wolrd", (v) => v.charCodeAt(0));

//     const signature = sign.update(encData).sign(sko);

//   //   console.log("Signature:",Uint8Array.from(signature));
//   //   console.log("SignatureB64:",signature.toString("base64"));

//   {
//     const verify = createVerify("RSA-SHA256");

//     const verifyResult1 = verify.update(encData).verify(pko, signature);
//     console.log("Verify result:", verifyResult1);
//   }
//   encData[0]++;

//   {
//     const verify = createVerify("RSA-SHA256");

//     const verifyResult1 = verify.update(encData).verify(pko, signature);
//     console.log("Verify result:", verifyResult1);
//   }
// };

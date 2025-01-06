import { sha256 } from "./sha256";

// GenerationParams should be sent over the wire as:
// { initBytes:[], signature:[] } , the first 6 of the bytes are a notBefore timestamp (to be decoded and replaced for UUID generation), the signature is used to verify the initBytes upon re-connections
export interface SerializedGenerationParams {
  initBytesBase64: string;
  signatureBase64: string;
  // If we intend to support multiple keys then we will need the below
  //   signatureMethod: string;
  //   keyHash: string;
}

export interface UUIDGeneratorState {
  notBefore: number;
  lastGenTS: number;
  lastGenSeq: number;
  seed: Uint8Array;
  privKey: any;
  pubKey?: any;
}

// TODO: verify signature?
export const signedInfoToUuid7GenParams = (obj: SerializedGenerationParams) => {
  let notBefore = 0;
  let seed = Uint8Array.from(atob(obj.initBytesBase64), (v) => v.charCodeAt(0));
  for (let i = 0; i < 6; i++) {
    notBefore = notBefore * 256 + seed[i];
    seed[i] = 0;
  }
  return {
    notBefore,
    lastGenTS: notBefore,
    lastGenSeq: 0,
    seed,
    privKey: obj.signatureBase64,
  } as UUIDGeneratorState;
};

export const newUUIDv7Bytes = (
  gp: UUIDGeneratorState,
  ts?: number,
  seq?: number
) => {
  // if used in fire-and-forget mode by leaving out TS we will try to generate to the best of the ability
  if (ts === undefined) {
    ts = Date.now();
    ts = Math.floor(ts);

    // never generate in the "past"
    if (ts < gp.lastGenTS) ts = gp.lastGenTS;
    // keep a sequence count for each millisecond
    if (ts === gp.lastGenTS) {
      gp.lastGenSeq++;
      if (gp.lastGenSeq >= 16 * 256) {
        gp.lastGenSeq = 0;
        gp.lastGenTS = ts = ts + 1;
      }
    } else {
      gp.lastGenSeq = 0;
    }
    seq = gp.lastGenSeq;
  } else {
    ts = Math.floor(ts);
    seq = seq ?? 0;
  }

  // tweak the seed with the timestamp to get entropy for our sha256 pseudo-randomization
  const seedBytes = new Uint8Array(gp.seed);
  for (let i = 0; i < 6; i++) {
    seedBytes[i] = 255 & (ts / Math.pow(256, 5 - i));
  }
  seedBytes[6] = (seq >> 8) & 0xff;
  seedBytes[7] = seq & 0xff;
  // just use the early sha256 bytes as our random data.
  const digested = sha256(seedBytes);
  const uuid = digested.slice(0, 16);
  // set a correct timestamp
  for (let i = 0; i < 6; i++) {
    uuid[i] = 255 & (ts / Math.pow(256, 5 - i));
  }
  // and then the version bytes as per the spec (and our 12bit sequence number)
  //uuid[6] = 0x70 | (uuid[6] & 0x0f); // set version field, top four bits are 0, 1, 1, 1
  uuid[6] = 0x70 | ((seq >> 8) & 0xf); // set version field, top four bits are 0, 1, 1, 1
  uuid[7] = seq & 0xff;
  uuid[8] = 0x80 | (uuid[8] & 0x3f); // set variant field, top two bits are 1, 0
  // this leaves us with 62 bits of entropy per millisecond
  return uuid;
};

export const isUUIDv7 = (uuid: Uint8Array) => {
  return (
    uuid.length === 16 && (uuid[6] & 0xf0) === 0x70 && (uuid[8] & 0xc0) === 0x80
  );
};

export const getUUIDv7Timestamp = (uuid: Uint8Array) => {
  let timeStamp = 0;
  for (let i = 0; i < 6; i++) {
    timeStamp = timeStamp * 256 + uuid[i];
  }
  return timeStamp;
};

export const getUUIDv7SeqNo = (uuid: Uint8Array) => {
  return ((uuid[6] & 0xf) << 8) + (uuid[7] & 0xff);
};

export const uuidBytesToString = (bytes: Uint8Array) => {
  const out = [] as string[];
  for (let i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out.push("-");
    out.push((bytes[i] >> 4).toString(16));
    out.push((bytes[i] & 0xf).toString(16));
  }
  return out.join("");
};

// 2e6f0cf6-172c-4896-a496-b673a119c34a
const dashCode = "-".charCodeAt(0);

const hexAsciiToBits = (ascii: number) =>
  // case for ascii 0-9
  48 <= ascii && ascii <= 57
    ? ascii - 48
    : // case for lowercase a-f
      97 <= ascii && ascii <= 102
      ? ascii - 97 + 10
      : // case for uppercase A-F
        65 <= ascii && ascii <= 70
        ? ascii - 65 + 10
        : // all others are invalid
          -1;

// strict uuid parser
export const parseUUIDString = (str: string) => {
  if (str.length !== 36) return null;
  // 2 passes, first we do a dry-run then secondly a sharp run with an buffer allocated.
  for (let i = 0; i < 2; i++) {
    const obuf = i == 1 ? new Uint8Array(16) : null;
    let iidx = 0;
    let oidx = 0;
    while (iidx < 36 && oidx < 16) {
      // first charcode
      const cc0a = str.charCodeAt(iidx);
      // allow dashes
      if (cc0a == dashCode) {
        // but only at certain positions
        if (iidx !== 8 && iidx !== 13 && iidx !== 18 && iidx !== 23)
          return null; // dashes wrongly positioned.
        iidx++;
        continue;
      }
      // not a dash, get the hex values
      const cc0 = hexAsciiToBits(cc0a);
      const cc1 = hexAsciiToBits(str.charCodeAt(iidx + 1));
      // fault if a hexvalue wasn't detected.
      if (cc0 == -1 || cc1 == -1) return null;
      // write or pass.
      if (obuf) obuf[oidx++] = (cc0 << 16) | cc1;
      else oidx++;
      iidx += 2;
    }
    // verify that we parsed an valid uuid string
    if (iidx !== 36 || oidx !== 16) return null;
    // finally return the buffer.
    if (obuf) return obuf;
  }
  throw new Error("Undefined!");
};

//[...bytes].map((v,i)=>(i==4||i==6||i==8||i==12)?`-${v.toString(16)}`:)

export const newUUIDv7String = (
  gp: UUIDGeneratorState,
  ts?: number,
  seq?: number
) => {
  return uuidBytesToString(newUUIDv7Bytes(gp, ts, seq));
};

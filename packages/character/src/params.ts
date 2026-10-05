/**
 * The character is a small set of numbers (ARCHITECTURE §9.2). Every renderer,
 * from the browser canvas to the ESP32 display, draws from these.
 */
export const PARAM_KEYS = [
  "eyeOpen", // 0 closed · 1 normal · >1 wide
  "eyeSquint", // lower lids rising (smiling eyes)
  "pupilX", // -1 left · 1 right
  "pupilY", // -1 up · 1 down
  "pupilSize",
  "browHeight", // -1 low · 1 raised
  "browAngle", // >0 inner ends up (worried) · <0 inner ends down (angry)
  "browAsym", // >0 left brow up, right brow down
  "mouthCurve", // -1 frown · 1 smile
  "mouthOpen",
  "mouthWidth",
  "mouthRound", // 0 wide · 1 "oo"
  "cheek", // blush
  "headTilt", // radians
  "bounce", // vertical offset, negative is up
  "squash", // >0 squashed · <0 stretched
  "armL", // radians from hanging down; ~1.57 is straight out, <0 crosses in front of her
  "armR",
  "bendL", // rubber-hose elbow curve: >0 bows outward/up, <0 inward/down
  "bendR",
  "reachL", // arm length factor; small values pull the hand in close to her body
  "reachR",
  "lean", // radians; >0 slumps or bows forward
  "tear", // 0..1 a tear rolling down
  "handSpeed", // extra clock-hand spin, revolutions per ~2 s
] as const;

export type ParamKey = (typeof PARAM_KEYS)[number];
export type RigParams = Record<ParamKey, number>;

export const NEUTRAL: RigParams = {
  eyeOpen: 1,
  eyeSquint: 0.05,
  pupilX: 0,
  pupilY: 0,
  pupilSize: 1,
  browHeight: 0,
  browAngle: 0,
  browAsym: 0,
  mouthCurve: 0.25,
  mouthOpen: 0,
  mouthWidth: 1,
  mouthRound: 0,
  cheek: 0.25,
  headTilt: 0,
  bounce: 0,
  squash: 0,
  armL: 0.45,
  armR: 0.45,
  bendL: 0.35,
  bendR: 0.35,
  reachL: 1,
  reachR: 1,
  lean: 0,
  tear: 0,
  handSpeed: 0,
};

/** Glove shapes, from her reference sheet. */
export type HandPose = "open" | "fist" | "point" | "thumb";

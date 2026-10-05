// A sheet of her poses for checking the renderer: every emotion, then movement.
import { CharacterRig, VISEMES, type Action } from "@ms-minutes/character";
import { Affect } from "@ms-minutes/protocol";
import { ClockRenderer } from "./renderer.js";

type Shot = { label: string; setup: (rig: CharacterRig) => void; seconds: number; talk?: boolean };

const still = (rig: CharacterRig) => {
  rig.motion.autopilot = false;
};

const shots: Shot[] = [
  ...Affect.options.map((affect) => ({
    label: affect,
    seconds: 1.5,
    setup: (rig: CharacterRig) => {
      still(rig);
      rig.setExpression(affect, 1);
    },
  })),
  {
    label: "talking",
    seconds: 1,
    talk: true,
    setup: (rig) => (still(rig), rig.setExpression("happy", 0.6)),
  },
  ...(
    [
      ["walk", 0.9],
      ["run", 0.5],
      ["jump", 0.36],
      ["turn_around", 0.9],
      ["spin", 0.35],
      ["sit", 1.5],
      ["dance", 0.6],
      ["bow", 0.6],
      ["come_closer", 1.8],
      ["wave", 0.5],
    ] as [Action, number][]
  ).map(([action, seconds]) => ({
    label: action,
    seconds,
    setup: (rig: CharacterRig) => {
      still(rig);
      rig.setExpression(action === "sit" ? "shy" : "happy", 0.8);
      rig.act(action);
    },
  })),
];

const seeded = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

// ?only=happy,sad&cell=600 shows just those, bigger.
const params = new URLSearchParams(location.search);
const only = params.get("only")?.split(",");
if (params.get("cell")) document.body.style.setProperty("--cell", `${params.get("cell")}px`);

for (const shot of shots.filter((s) => !only || only.includes(s.label))) {
  const figure = document.createElement("figure");
  const canvas = document.createElement("canvas");
  const caption = document.createElement("figcaption");
  caption.textContent = shot.label;
  figure.append(canvas, caption);
  document.body.append(figure);

  const rig = new CharacterRig({ random: seeded(3) });
  shot.setup(rig);
  if (shot.talk) rig.setViseme(VISEMES.wide);
  let frame = rig.update(0);
  for (let t = 0; t < shot.seconds; t += 1 / 60)
    frame = rig.update(1 / 60, new Date(2026, 0, 1, 10, 10));
  requestAnimationFrame(() => new ClockRenderer(canvas).draw(frame));
}

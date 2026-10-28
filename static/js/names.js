// Random route names: "<adjective> <noun>", e.g. "Crimson Gecko".

const ADJECTIVES = [
  'Crimson', 'Quiet', 'Velvet', 'Lazy', 'Electric', 'Hidden', 'Rusty', 'Golden', 'Silent', 'Wobbly',
  'Midnight', 'Feral', 'Gentle', 'Spicy', 'Frozen', 'Cosmic', 'Sneaky', 'Polished', 'Brittle', 'Lucky',
  'Savage', 'Patient', 'Hollow', 'Neon', 'Sticky', 'Sideways', 'Barefoot', 'Thundering', 'Crooked', 'Sleepy',
  'Restless', 'Tiny', 'Grumpy', 'Dusty', 'Wild', 'Humble', 'Iron', 'Paper', 'Copper', 'Phantom',
];

const NOUNS = [
  'Gecko', 'Riot', 'Undertow', 'Sunday', 'Prophet', 'Fog', 'Crimp', 'Lizard', 'Pinch', 'Comet',
  'Heel Hook', 'Monkey', 'Ladder', 'Traverse', 'Owl', 'Sloper', 'Tide', 'Dyno', 'Raven', 'Pocket',
  'Shark', 'Avalanche', 'Kneebar', 'Lantern', 'Cactus', 'Badger', 'Highball', 'Spider', 'Volcano', 'Mantle',
  'Sidepull', 'Pebble', 'Ghost', 'Thunder', 'Jug', 'Falcon', 'Compass', 'Orbit', 'Gaston', 'Moth',
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// `taken` is an optional collection of existing names to avoid.
export function randomName(taken = []) {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  for (let i = 0; i < 50; i++) {
    const name = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  return `${pick(ADJECTIVES)} ${pick(NOUNS)} ${Math.floor(Math.random() * 90) + 10}`;
}

// The only icons a saved food can have: food and drink emojis (no faces, objects, utensils, etc).
// Each item is [emoji, name]; the name is also used for search and screen readers.
export const FOOD_EMOJI_GROUPS = [
  { label: 'Fruit', items: [
    ['🍎', 'apple'], ['🍏', 'green apple'], ['🍐', 'pear'], ['🍊', 'orange'], ['🍋', 'lemon'], ['🍌', 'banana'],
    ['🍉', 'watermelon'], ['🍇', 'grapes'], ['🍓', 'strawberry'], ['🫐', 'blueberries'], ['🍈', 'melon'],
    ['🍒', 'cherries'], ['🍑', 'peach'], ['🥭', 'mango'], ['🍍', 'pineapple'], ['🥥', 'coconut'], ['🥝', 'kiwi'],
  ] },
  { label: 'Vegetables & nuts', items: [
    ['🍅', 'tomato'], ['🥑', 'avocado'], ['🫒', 'olive'], ['🥦', 'broccoli'], ['🥬', 'leafy greens'], ['🥒', 'cucumber'],
    ['🌶️', 'hot pepper'], ['🫑', 'bell pepper'], ['🌽', 'corn'], ['🥕', 'carrot'], ['🧄', 'garlic'], ['🧅', 'onion'],
    ['🥔', 'potato'], ['🍠', 'sweet potato'], ['🍆', 'eggplant'], ['🍄', 'mushroom'], ['🫘', 'beans'], ['🥜', 'peanuts'],
    ['🌰', 'chestnut'],
  ] },
  { label: 'Bread, breakfast & dairy', items: [
    ['🍞', 'bread'], ['🥐', 'croissant'], ['🥖', 'baguette'], ['🫓', 'flatbread'], ['🥨', 'pretzel'], ['🥯', 'bagel'],
    ['🥞', 'pancakes'], ['🧇', 'waffle'], ['🥣', 'cereal'], ['🥚', 'egg'], ['🍳', 'fried egg'], ['🧀', 'cheese'],
    ['🧈', 'butter'], ['🥛', 'milk'],
  ] },
  { label: 'Meat & seafood', items: [
    ['🍗', 'chicken'], ['🍖', 'meat'], ['🥩', 'steak'], ['🥓', 'bacon'], ['🐟', 'fish'], ['🍤', 'fried shrimp'],
    ['🦐', 'shrimp'], ['🦀', 'crab'], ['🦞', 'lobster'], ['🦑', 'squid'], ['🦪', 'oyster'],
  ] },
  { label: 'Meals', items: [
    ['🍔', 'burger'], ['🍟', 'fries'], ['🍕', 'pizza'], ['🌭', 'hot dog'], ['🥪', 'sandwich'], ['🌮', 'taco'],
    ['🌯', 'burrito'], ['🫔', 'tamale'], ['🥙', 'wrap'], ['🧆', 'falafel'], ['🥗', 'salad'], ['🍝', 'pasta'],
    ['🍜', 'noodles'], ['🍲', 'soup'], ['🥘', 'paella'], ['🫕', 'fondue'], ['🍛', 'curry'], ['🍚', 'rice'],
    ['🍙', 'rice ball'], ['🍘', 'rice cracker'], ['🍱', 'bento'], ['🍣', 'sushi'], ['🥟', 'dumpling'], ['🍥', 'fish cake'],
    ['🍢', 'oden'], ['🥡', 'takeout'], ['🥫', 'canned food'], ['🍿', 'popcorn'], ['🧂', 'salt'],
  ] },
  { label: 'Sweets', items: [
    ['🍫', 'chocolate'], ['🍬', 'candy'], ['🍭', 'lollipop'], ['🍪', 'cookie'], ['🍩', 'doughnut'], ['🧁', 'cupcake'],
    ['🍰', 'cake'], ['🎂', 'birthday cake'], ['🥧', 'pie'], ['🍮', 'custard'], ['🍦', 'soft serve'], ['🍨', 'ice cream'],
    ['🍧', 'shaved ice'], ['🍡', 'dango'], ['🥮', 'moon cake'], ['🥠', 'fortune cookie'], ['🍯', 'honey'],
  ] },
  { label: 'Drinks', items: [
    ['☕', 'coffee'], ['🍵', 'tea'], ['🫖', 'teapot'], ['🧋', 'bubble tea'], ['🧃', 'juice'], ['🥤', 'soda'],
    ['🧉', 'mate'], ['🍺', 'beer'], ['🍷', 'wine'], ['🥃', 'whiskey'], ['🍸', 'cocktail'], ['🍹', 'tropical drink'],
    ['🍾', 'champagne'], ['🍶', 'sake'],
  ] },
];

export const FOOD_EMOJIS = FOOD_EMOJI_GROUPS.flatMap((g) => g.items);

// Compare without the invisible "show as emoji" selector, so 🌶 and 🌶️ count as the same icon.
const bare = (s) => String(s ?? '').replace(/️/g, '');
const BY_EMOJI = new Map(FOOD_EMOJIS.map(([emoji, name]) => [bare(emoji), { emoji, name }]));

// The emoji if it's an allowed food emoji, otherwise ''.
export function sanitizeEmoji(value) {
  return BY_EMOJI.get(bare(value).trim())?.emoji ?? '';
}

export function emojiName(value) {
  return BY_EMOJI.get(bare(value).trim())?.name ?? '';
}

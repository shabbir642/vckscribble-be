import type { WordPackId } from '../contract/index.js';

/**
 * Word packs, beyond the corporate slang in words.seed.ts.
 *
 * Version-controlled like the slang list: changes show up in diffs. Seeding is
 * idempotent on the normalized text — a word that already exists keeps its
 * first pack and its hand-edited rating — so adding entries here is safe.
 *
 * Ratings are about DRAWABILITY, not obscurity:
 *   easy   — draws itself; a stick figure and a circle will do (cat, pizza)
 *   medium — needs a little setup or a second object (traffic light, high five)
 *   hard   — abstract or easily confused (procrastinate, photosynthesis)
 *
 * Plain comma-separated lists so a whole pack fits on a screen and reads like
 * the word list it is. Leave out brand names and anything that could sting.
 */
export const WORD_PACKS_SEED: Record<
  Exclude<WordPackId, 'slang'>,
  { easy: string; medium: string; hard: string }
> = {
  everyday: {
    easy: `sock, shoe, hat, glasses, key, door, window, chair, table, bed, lamp, clock, cup, spoon,
      fork, knife, plate, bottle, book, pencil, scissors, umbrella, balloon, candle, bucket, ladder,
      toothbrush, comb, mirror, pillow, blanket, bathtub, toilet, sink, towel, soap, broom, hammer,
      nail, screw, rope, box, bag, wallet, ring, necklace, crown, button, zipper, belt, tie, dress,
      shirt, trousers, glove, scarf, boot, sandal, backpack, envelope, gift, kite, bell, flag, tent,
      fence, mailbox, trash can, light bulb, battery, magnet, sponge, bowl, teapot, kettle,
      frying pan, fridge, oven, toaster, fan, plug, remote control, paintbrush, crayon, eraser, ruler,
      map, coin, padlock, hanger, basket, vase, curtain, rug, stairs, chimney, roof, sofa, bicycle,
      car, bus, train, boat, plane, rocket, truck, tractor, helicopter, scooter, skateboard,
      ambulance, taxi, traffic light, anchor, sailboat, submarine, hot air balloon, bench, swing,
      slide, wheel, bone, heart, smiley face, mug`,
    medium: `alarm clock, piggy bank, safety pin, shopping cart, sleeping bag, flashlight, hourglass,
      magnifying glass, rocking chair, bunk bed, hair dryer, ironing board, washing machine,
      dishwasher, vacuum cleaner, lawn mower, wheelbarrow, watering can, mousetrap,
      fire extinguisher, smoke alarm, doormat, garden hose, birdhouse, treasure chest, suitcase,
      passport, ticket, keychain, sunglasses, flip flops, bow tie, high heels, raincoat, apron,
      pajamas, slippers, mittens, earmuffs, tissue box, shower, toothpaste, perfume, lipstick,
      nail polish, hairbrush, razor, first aid kit, seatbelt, steering wheel, parachute, canoe,
      jet ski, cable car, escalator, elevator, revolving door, seesaw, sandbox, snow globe,
      jigsaw puzzle, rubber duck, teddy bear, yo-yo, slingshot, boomerang, whistle, compass,
      telescope, microscope, binoculars, megaphone, stopwatch, wind chime, ceiling fan,
      bottle opener, rolling pin, cheese grater, salt shaker, pressure cooker, lunch box,
      water bottle, umbrella stand, coat rack, bookshelf, picture frame, doorknob`,
    hard: `chandelier, thermostat, extension cord, dream catcher, origami, kaleidoscope, metronome,
      sundial, tuning fork, abacus, periscope, time capsule, jack-in-the-box, music box, lava lamp,
      bean bag, hammock, coaster, placemat, napkin ring, lint roller, shoehorn`,
  },

  animals: {
    easy: `cat, dog, fish, bird, cow, pig, horse, sheep, duck, chicken, frog, snake, lion, tiger,
      elephant, giraffe, monkey, zebra, bear, panda, rabbit, mouse, owl, penguin, shark, whale,
      dolphin, octopus, crab, snail, turtle, butterfly, bee, spider, ant, ladybug, bat, camel,
      kangaroo, koala, fox, wolf, deer, squirrel, hedgehog, parrot, flamingo, peacock, swan, eagle,
      crocodile, dinosaur, starfish, jellyfish, seahorse, worm, caterpillar, goat, donkey, hippo,
      rhino, gorilla, polar bear, seal, walrus, puppy, kitten`,
    medium: `lobster, shrimp, squid, stingray, pufferfish, clownfish, goldfish, hamster, guinea pig,
      raccoon, skunk, beaver, otter, mole, chipmunk, porcupine, sloth, armadillo, platypus,
      anteater, chameleon, iguana, lizard, scorpion, mosquito, dragonfly, grasshopper, cockroach,
      firefly, moth, beetle, centipede, slug, toucan, pelican, ostrich, vulture, woodpecker,
      hummingbird, crow, pigeon, seagull, puffin, rooster, turkey, llama, bison, moose, reindeer,
      yak, cheetah, leopard, hyena, meerkat, lemur, chimpanzee, orangutan, piranha, eel, narwhal,
      manatee, orca, hammerhead shark, sea turtle, tadpole, poodle, dalmatian, bulldog, sausage dog,
      peacock feather, bird nest, spider web, beehive, dog bone, fish bowl`,
    hard: `axolotl, pangolin, tapir, okapi, wombat, quokka, capybara, mongoose, wolverine, aardvark,
      lynx, gazelle, antelope, warthog, komodo dragon, tarantula, praying mantis, stick insect,
      hermit crab, sea urchin, coral, plankton, barnacle`,
  },

  food: {
    easy: `apple, banana, orange, grapes, strawberry, cherry, watermelon, pineapple, lemon, pear,
      peach, carrot, corn, tomato, potato, mushroom, broccoli, onion, egg, bread, cheese, pizza,
      burger, hot dog, fries, sandwich, cake, cookie, ice cream, donut, candy, lollipop, popcorn,
      chocolate, milk, coffee, tea, juice, soup, salad, pasta, noodles, rice, sushi, taco, pancake,
      waffle, cupcake, pie, honey, sausage, bacon, drumstick, steak, coconut, avocado, pumpkin,
      cucumber, chilli, garlic, peas, cherries, ice cream cone, birthday cake`,
    medium: `croissant, pretzel, bagel, muffin, burrito, nachos, dumpling, spring roll, ramen,
      spaghetti, lasagna, meatball, kebab, omelette, fried egg, toast, cereal, yogurt, smoothie,
      milkshake, lemonade, popsicle, wedding cake, gingerbread man, candy cane, cotton candy,
      marshmallow, s'mores, peanut butter, ketchup, mustard, salt, sugar, butter, pickle, olive,
      blueberry, raspberry, kiwi, mango, papaya, pomegranate, plum, lime, eggplant, cabbage,
      lettuce, celery, radish, spinach, cauliflower, sweet potato, corn dog, chicken nuggets,
      fish and chips, fortune cookie, samosa, biryani, dosa, idli, naan, chapati, curry, jalebi,
      chai, pani puri, vada pav, lassi, gulab jamun, paratha, momos, pav bhaji, tea bag,
      coffee bean, soda, bubble tea, fruit salad, chocolate bar, popcorn bucket, pizza slice`,
    hard: `quiche, risotto, gazpacho, tiramisu, crème brûlée, soufflé, bruschetta, ratatouille,
      guacamole, hummus, falafel, kimchi, tofu, tempura, edamame, wasabi, buffet, leftovers,
      brunch, potluck`,
  },

  office: {
    easy: `stapler, paper clip, pen, laptop, desk, coffee mug, printer, phone, calculator, keyboard,
      computer mouse, monitor, folder, notebook, sticky note, whiteboard, marker, tape, clipboard,
      calendar, badge, briefcase, water cooler, coffee machine, office plant, name tag,
      highlighter, push pin, rubber band, glue stick, filing cabinet, headset, webcam, projector,
      desk lamp, swivel chair, binder, paper shredder, photocopier, pizza box`,
    medium: `org chart, pie chart, bar chart, standing desk, ID card, key card, video call,
      conference call, out of office, team lunch, office party, birthday card, spreadsheet,
      slide deck, presentation, deadline, to-do list, coffee stain, paperwork, payday, promotion,
      job interview, handshake, business card, suit and tie, cubicle, open office, fire drill,
      printer jam, tangled cables, mouse pad, reply all, coffee break, lunch break, meeting room,
      sticky note wall, email inbox, overtime, weekend, monday morning`,
    hard: `inbox zero, quarterly report, performance review, team building, work from home,
      burnout, imposter syndrome, onboarding, small talk, office politics, work-life balance`,
  },

  actions: {
    easy: `run, jump, swim, sleep, eat, drink, read, write, sing, dance, cry, laugh, smile, wave,
      clap, kick, throw, catch, climb, fly, fall, sit, walk, cook, paint, sneeze, yawn, hug, wink,
      point, push, pull, dig, skate, ski, surf, juggle, sweep, knock, shout, whisper, think, bow,
      crawl, hop, spin, kneel, sweat, shiver, fishing`,
    medium: `brush teeth, take a selfie, high five, fist bump, tie shoes, blow bubbles,
      pop a balloon, walk the dog, mow the lawn, wash dishes, do laundry, take a shower,
      fall asleep, wake up, stretch, meditate, yoga, lift weights, jump rope, play guitar,
      play piano, make a wish, blow out candles, tiptoe, slip on a banana, trip over, sunbathe,
      build a snowman, throw a snowball, fly a kite, row a boat, ride a bike, walk a tightrope,
      shrug, facepalm, eye roll, thumbs up, salute, hiccup, snore, daydream, arm wrestle,
      piggyback ride, sleepwalk, moonwalk, cartwheel, somersault`,
    hard: `procrastinate, eavesdrop, multitask, apologize, negotiate, celebrate, hesitate,
      improvise, overthink, binge watch, doomscroll, gossip, brag, bargain, forget`,
  },

  places: {
    easy: `house, castle, school, hospital, farm, beach, island, mountain, desert, forest, cave,
      igloo, pyramid, bridge, lighthouse, tower, zoo, park, playground, library, museum, airport,
      train station, bus stop, garden, swimming pool, stadium, cinema, restaurant, cafe, bakery,
      supermarket, shop, bank, hotel, factory, barn, treehouse, palace, prison, road, city`,
    medium: `skyscraper, apartment, haunted house, amusement park, roller coaster, ferris wheel,
      carousel, circus, aquarium, bowling alley, gym, spa, hair salon, laundromat, petrol pump,
      car wash, drive-through, food court, shopping mall, market, harbour, campsite, ski resort,
      space station, observatory, planetarium, laboratory, fire station, police station,
      post office, courthouse, construction site, junkyard, graveyard, windmill, colosseum,
      Eiffel Tower, Taj Mahal, Statue of Liberty, Great Wall, Big Ben, Leaning Tower of Pisa,
      Gateway of India, India Gate, North Pole, railway track, toll booth, zebra crossing`,
    hard: `suburb, downtown, countryside, crossroads, dead end, roundabout, waiting room,
      lost and found, backstage, rooftop, basement, attic, balcony, corridor`,
  },

  nature: {
    easy: `sun, moon, star, cloud, rain, snow, rainbow, lightning, tree, flower, leaf, grass, rock,
      river, ocean, wave, sunflower, rose, cactus, palm tree, volcano, waterfall, snowflake, fire,
      ice, pine tree, acorn, puddle, iceberg, lake, hill`,
    medium: `tornado, hurricane, earthquake, avalanche, sunrise, sunset, full moon, crescent moon,
      shooting star, comet, planet, eclipse, northern lights, fog, hail, thunderstorm, tsunami,
      glacier, canyon, cliff, valley, swamp, jungle, meadow, oasis, coral reef, sand dune,
      bonfire, campfire, autumn leaves, cherry blossom, lotus, tulip, daisy, bamboo, vine, moss,
      seaweed, pebble, crystal, geyser, hot spring, solar system, monsoon, dew drop, spider plant`,
    hard: `photosynthesis, gravity, evaporation, erosion, climate change, ecosystem, solstice,
      equator, horizon, humidity, drought, galaxy, black hole`,
  },

  sports: {
    easy: `ball, football, basketball, tennis, golf, baseball, cricket, boxing, swimming, skiing,
      bowling, darts, chess, dice, playing cards, trophy, medal, goal, net, bat, racket, helmet,
      puzzle, video game, joystick, kite flying, skipping rope, whistle`,
    medium: `volleyball, badminton, table tennis, hockey, ice skating, snowboarding, karate, judo,
      wrestling, sumo, fencing, archery, gymnastics, marathon, relay race, high jump, long jump,
      pole vault, hurdles, javelin, weightlifting, cycling, rowing, sailing, scuba diving,
      rock climbing, bungee jumping, skydiving, horse riding, rugby, kabaddi, carrom, ludo,
      snakes and ladders, hide and seek, tug of war, musical chairs, hopscotch, dodgeball,
      frisbee, hula hoop, trampoline, finish line, scoreboard, referee, cheerleader, mascot,
      penalty kick, slam dunk, home run, hat trick, checkmate, rubik's cube, board game, bingo,
      crossword, sudoku, gold medal, cricket bat, goalkeeper, red card`,
    hard: `offside, underdog, comeback, photo finish, personal best, stalemate, fair play,
      sportsmanship, extra time, tie breaker`,
  },

  tech: {
    easy: `computer, robot, camera, television, radio, headphones, microphone, speaker, satellite,
      game controller, smartwatch, tablet, drone, wifi, usb stick, charger, email, emoji, laptop
      bag, battery charger, selfie stick, light switch`,
    medium: `smartphone, power bank, bluetooth, qr code, barcode, hashtag, like button, download,
      upload, loading bar, error message, spam, computer virus, cloud storage, hard drive, server,
      circuit board, solar panel, electric car, self-driving car, vr headset, 3d printer,
      hologram, wireless earbuds, live stream, podcast, meme, autocorrect, dark mode,
      low battery, screenshot, captcha, pop-up ad, notification, group chat, voice note,
      password, keyboard shortcut, mute button, no signal, dead pixel`,
    hard: `algorithm, artificial intelligence, machine learning, blockchain, cryptocurrency,
      cybersecurity, encryption, latency, metaverse, internet of things, open source, bug fix,
      deployment, debugging, merge conflict, dark web, phishing, two-factor authentication,
      software update, dependency, technical debt`,
  },

  jobs: {
    easy: `doctor, nurse, teacher, chef, firefighter, police officer, pilot, farmer, astronaut,
      artist, singer, clown, magician, pirate, king, queen, prince, princess, knight, ninja,
      cowboy, soldier, sailor, builder, postman, waiter, baker, dentist, scientist, detective,
      superhero, lifeguard, gardener, fisherman, painter, dancer`,
    medium: `plumber, electrician, mechanic, carpenter, architect, engineer, photographer,
      journalist, lawyer, judge, cashier, barista, hairdresser, tailor, butcher, florist,
      librarian, zookeeper, vet, surgeon, pharmacist, paramedic, coach, DJ, rock star,
      influencer, gamer, programmer, designer, intern, receptionist, security guard,
      delivery driver, taxi driver, bus driver, construction worker, miner, lumberjack,
      beekeeper, shepherd, explorer, archaeologist, mountaineer, stunt double, mime, juggler,
      acrobat, tightrope walker, auto rickshaw driver, chaiwala`,
    hard: `accountant, consultant, recruiter, data scientist, product manager, scrum master,
      project manager, therapist, economist, philosopher, entrepreneur, freelancer, auditor,
      actuary, CEO, manager`,
  },

  fantasy: {
    easy: `unicorn, dragon, ghost, witch, wizard, fairy, mermaid, monster, alien, vampire, zombie,
      magic wand, treasure, pirate ship, spaceship, ufo, sword, shield, crystal ball, snowman,
      santa claus, easter bunny, tooth fairy, jack-o'-lantern, skeleton, mummy, werewolf, giant,
      troll, elf, gnome, goblin, genie, phoenix, pegasus, yeti, bigfoot, cyclops, centaur,
      superpower`,
    medium: `flying carpet, magic lamp, potion, spell book, broomstick, cauldron, time machine,
      invisibility cloak, treasure map, message in a bottle, ghost ship, sea monster, robot dog,
      teleport, portal, sidekick, villain, hero, secret agent, invisible man, mad scientist,
      zombie apocalypse, alien invasion, fortune teller, enchanted forest, dragon egg,
      golden goose, beanstalk, glass slipper, pumpkin carriage, gingerbread house, candy land,
      fairy godmother, wishing well, four leaf clover, lucky charm, horseshoe, loch ness monster,
      kraken, haunted mirror, magic carpet ride, flying pig`,
    hard: `prophecy, curse, destiny, parallel universe, time travel, déjà vu, multiverse,
      telepathy, immortality, shapeshifter, doppelganger, minotaur`,
  },
  desi: {
    easy: `samosa, jalebi, ladoo, dosa, idli, roti, naan, paratha, biryani, chai, kulfi, lassi,
      pani puri, vada pav, thali, pakora, rasgulla, gulab jamun, momos, paan, rangoli, diya,
      mehendi, bindi, bangles, saree, kurta, turban, lungi, dhoti, chappal, jhumka, tabla, sitar,
      dhol, matka, tiffin box, pressure cooker, charpai, hand pump, auto rickshaw, cycle rickshaw,
      taj mahal, india gate, cricket bat, stumps, kite festival, coconut tree, banyan tree, cow on
      the road, holi, diwali, sparkler`,
    medium: `cutting chai, filter coffee, masala dosa, chole bhature, pav bhaji, kaju katli,
      sugarcane juice, nimbu pani, coconut water, street food stall, chaiwala, dabbawala,
      local train, overcrowded bus, traffic jam, speed breaker, honking, power cut, monsoon,
      mosquito net, bucket bath, steel tumbler, rolling pin, tandoor, spice box, pickle jar,
      dupatta, sherwani, nose ring, anklet, wedding baraat, mandap, dandiya, garba, bhangra,
      kathakali, bharatanatyam, eid, pongal, onam, durga puja, navratri, raksha bandhan, lohri
      bonfire, red fort, gateway of india, qutub minar, charminar, hawa mahal, howrah bridge,
      houseboat, ghat, marine drive, gully cricket, sixer, hat trick, run out, wicket keeper,
      umpire, googly, yorker, kabaddi, carrom, ludo, snakes and ladders, antakshari,
      dumb charades, rain dance, hero entry, villain laugh, item song, evil eye charm,
      tuition class, board exams, school assembly, report card, rickshaw ride, train window seat`,
    hard: `jugaad, timepass, chalta hai, bas paanch minute, ghar ka khana, log kya kahenge,
      indian stretchable time, sharma ji ka beta, arranged marriage, bargaining, overthinking chai,
      lost at the mela, dance in switzerland, slow motion entry, family drama, sholay, lagaan,
      3 idiots, dangal, taare zameen par, chak de india, baahubali, mother india,
      dilwale dulhania le jayenge, hum aapke hain koun, mughal e azam`,
  },

  /**
   * Diwali is celebrated by Hindus, Sikhs and Jains and enjoyed by everyone in
   * India, so the pack keeps to what all of them share: lights, sweets, gifts,
   * family, the office party. No deities, no rituals, no card games (at Diwali
   * they mean gambling). Many cities ban or restrict crackers, so sparklers
   * and fireworks are the only ones here.
   */
  diwali: {
    easy: `diya, rangoli, lantern, fairy lights, sparkler, fireworks, ladoo, mithai box, gift box,
      gold coin, shopping bags, kurta, saree, lehenga, grandparents`,
    medium: `marigold, dry fruits box, gift hamper, greeting card, family photo, toran,
      marigold garland, lighting diyas, floating diyas, putting up lights,
      tangled lights, kaju katli, soan papdi, sweet shop, making sweets, sharing sweets,
      diwali cleaning, cleaning the fan, painting the house, new clothes, matching outfits,
      shopping rush, diwali sale, online shopping, flower market, new car, empty wallet,
      gift wrapping, opening gifts, gift exchange, relatives visiting, pile of shoes, bhai dooj,
      family dinner, family video call, office diwali party, virtual party, ethnic day,
      ramp walk, rangoli competition, stepping on rangoli, diya painting, desk decoration,
      photo booth, team lunch, diwali bonus, diwali mela`,
    hard: `festival of lights, good over evil, light over darkness, new beginnings, prosperity,
      togetherness, family time, joy of giving, festive mood, diwali wishes, first diwali,
      home for diwali, dhanteras shopping, last-minute shopping, regifting, sugar rush,
      sweet tooth, sweets for breakfast, food coma, power bill, lights still up, long weekend,
      leave approved, best dressed`,
  },
};

/** Flattens the packs into seed rows: [text, pack, drawability]. */
export function packRows(): [string, Exclude<WordPackId, 'slang'>, 1 | 2 | 3][] {
  const rows: [string, Exclude<WordPackId, 'slang'>, 1 | 2 | 3][] = [];
  for (const [pack, tiers] of Object.entries(WORD_PACKS_SEED)) {
    const add = (list: string, d: 1 | 2 | 3) => {
      for (const w of list.split(',')) {
        const text = w.replace(/\s+/g, ' ').trim();
        if (text) rows.push([text, pack as Exclude<WordPackId, 'slang'>, d]);
      }
    };
    add(tiers.easy, 1);
    add(tiers.medium, 2);
    add(tiers.hard, 3);
  }
  return rows;
}

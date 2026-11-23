# Lighting a climb's holds with lasers or projection mapping

Market research and build plan, November 2026. The question is how to light the holds of the chosen climb on the Yuzu Board wall from a distance, with a scanning laser or a video projector, without wiring a light behind every hold.

> **Decision: two short-throw laser projectors, one on each side wall, both lighting the whole wall so each fills in the other's shadows.**
> [Part 1](#part-1-survey-of-options) is the market survey that led there. [Part 2](#part-2-deep-dive-into-the-chosen-setup) goes deep on building it: where the projectors go, which model, mounting, wiring, calibration and how it hooks into the app.

Prices are what retail listings showed in November 2026. They move a lot between sellers, so treat them as ranges. Photos are hotlinked from the vendors, and each one links to its source.

---

## Contents

**[Part 1: Survey of options](#part-1-survey-of-options)**

1. [Options at a glance](#options-at-a-glance)
2. [The wall in numbers](#the-wall-in-numbers)
3. [Option A: laser projectors built for climbing](#option-a-laser-projectors-built-for-climbing)
4. [Option B: general-purpose scanning lasers](#option-b-general-purpose-scanning-lasers)
5. [Option C: a video projector plus projection mapping](#option-c-a-video-projector-plus-projection-mapping) (chosen)
6. [Commercial gym systems](#commercial-gym-systems)
7. [Not projection: LED boards](#not-projection-led-boards)
8. [Side-by-side](#side-by-side)
9. [Safety and regulations](#safety-and-regulations)

**[Part 2: Deep dive into the chosen setup](#part-2-deep-dive-into-the-chosen-setup)**

10. [Why this setup](#why-this-setup)
11. [How two projectors cancel shadows](#how-two-projectors-cancel-shadows)
12. [Where to put them](#where-to-put-them)
13. [Choosing the pair](#choosing-the-pair)
14. [Mounting and protection](#mounting-and-protection)
15. [Driving two projectors](#driving-two-projectors)
16. [Power and control](#power-and-control)
17. [Alignment and calibration](#alignment-and-calibration)
18. [How it plugs into the Yuzu Board](#how-it-plugs-into-the-yuzu-board)
19. [Parts list and cost](#parts-list-and-cost)
20. [Risks and mitigations](#risks-and-mitigations)
21. [Install and test plan](#install-and-test-plan)

[Sources](#sources)

---

# Part 1: Survey of options

## Options at a glance

| Budget | Option | Why | Watch out for |
|---|---|---|---|
| **Under ~$500** | **[LZRvision](https://lzr.vision/)**, a laser route projector made for spray walls | Built for this exact job. A camera auto-aligns to the holds, and it works with the Crux and Boardsesh apps. Kickstarter backers paid about $343 on average. | Small Kickstarter maker. Green only for now, about 10 holds before it flickers, and no public API for a custom app like this one. |
| | *or* a DIY galvo laser: [Helios DAC](https://bitlasers.com/) ($114) + 20 kpps galvo kit (~$85–225) + a ≤5 mW laser module | Cheap, fully programmable from Python, Rust or Node, and stays in the eye-safe Class 3R range | Weekend-project effort. Single colour unless you add RGB. The galvos' scan angle decides how far back it must sit (see [the numbers](#the-wall-in-numbers)). |
| **~$500–1,500** | **[ViewSonic LS740HD](https://www.projectorcentral.com/ViewSonic-LS740HD.htm)** (5,000 lm laser DLP, portrait mode, ~$1,100) | The brightest light per dollar, and it can be mounted at any angle | A long-throw projector (1.13–1.47:1), so it needs to be **about 23–25 ft** from the wall. Likely too far for this room. |
| ✅ **$1,500+ (chosen, ×2)** | **[Optoma ZH450ST](https://www.projectorcentral.com/Optoma-ZH450ST.htm)** (4,200 lm, 0.5:1 short throw, mounts at any angle, ~$2,000) or **[BenQ LH830ST](https://www.benq.eu/en-eu/business/projector/lh830st.html)** (4,000 lm, 0.5:1, portrait OK, ~$2,000–2,100) | Covers the whole 11.5 × 12.2 ft wall from a short distance. Any number of holds at once, in the app's four role colours. A second unit from the other side fills in the climber's shadows. | On this 45° board the projectors need **12–16 ft** from the wall base, not the 10–11 ft a flat wall would ([Part 2](#where-to-put-them)). Dim the room lights. |
| | Stretch: **[Epson PowerLite L690SE](https://epson.com/p/V11HB36020)** (6,000 lm 3LCD, 0.5–0.7 zoom, lens shift, ~$5,100–5,700) | 3LCD keeps the coloured rings as bright as white. Zoom and lens shift give you freedom in where it goes. | Price, 20 lb weight. Portrait support isn't listed. |

**Why short-throw projectors won:** the app already knows every hold's position in inches, the wall has five separate planes, and climbers need four role colours. A projector lights any number of holds in any colour. A laser can't match that without becoming a Class 4 device aimed at people. The one weakness, a climber's own shadow, is fixed by a second projector from the other side.

---

## The wall in numbers

From [`geometry.py`](../geometry.py), the climbable surface runs from x = −9" to 129" and y = −19" to 127.75". That's **138" × 146.75" (11.5 × 12.2 ft)** across the main panel, footboard, two side panels and the ceiling. It's almost square, so any 16:9 or 16:10 projector wastes part of its image.

### How far back a projector has to sit (flat wall, faced square-on)

Throw distance = throw ratio × the image's long side.

| Image orientation | Image needed | 0.5:1 short throw | 0.7:1 | 1.13:1 standard | 1.47:1 |
|---|---|---|---|---|---|
| 16:9 landscape | 261" × 147" (299" diag) | **10.9 ft** | 15.2 ft | 24.6 ft | 32.0 ft |
| 16:9 portrait (rotated 90°) | 138" × 245" (281" diag) | **10.2 ft** | 14.3 ft | 23.1 ft | 30.1 ft |
| 16:10 portrait (WUXGA) | 138" × 221" (260" diag) | **9.2 ft** | 12.9 ft | 20.8 ft | 27.0 ft |

That's the textbook answer, and it's why a **~0.5:1 short-throw lens** is the right class. On the real 45° board the top of the wall leans toward the projector, which pushes the minimum out to 12–13 ft. [Where to put them](#where-to-put-them) has the full model.

### How bright the rings get

A video projector's light is spread over its whole image. Every lit pixel gets about *lumens ÷ image area*, whether it lights one hold or forty.

| Projector rating | 16:9 landscape (24.7 m²) | 16:9 portrait (21.8 m²) | 16:10 portrait (19.7 m²) |
|---|---|---|---|
| 1,000 lm (mini projector) | 40 lux | 46 lux | 51 lux |
| 4,000–4,200 lm | 162–170 lux | 183–192 lux | 203–214 lux |
| 5,000 lm | 202 lux | 229 lux | 254 lux |
| 6,000 lm | 243 lux | 275 lux | 305 lux |

A lit garage is often 100–300 lux, so **a 4,000 lm projector's rings show up clearly only with the wall lights dimmed** or aimed away from the wall. Two projectors overlapped double this wherever both reach. Rated lumens aren't guaranteed, and reviews disagree: a review quoted on ProjectorCentral found the ZH450ST short of its 4,200 lm claim, while Projector Reviews measured 4,296 lm in its brightest mode ([details](#choosing-the-pair)).

### A laser for comparison

A 5 mW green beam gives about 2.4 lm, all of it concentrated on the ring outlines. Drawing ten 6"-wide rings with a ~0.15" line puts **roughly 90–130 lux** on those lines. That's in the same range as a 4,000 lm projector, from a $20 laser diode. Unlike a projector, the light is shared out, so **40 holds get a quarter of the brightness of 10** and start to flicker.

### Scan angle decides where a laser sits

To cover 146.75" of height, a laser needs a **63° scan at 10 ft** or a 44° scan at 15 ft. Published maximums: LaserCube WiFi ≈ 26°, which means sitting **~26 ft** back, and LaserCube Ultra ≈ 37° (**~18 ft**). Cheap galvos are fast only at small angles (the "kpps @ 8°" rating) and slow down when driven wider.

---

## Option A: laser projectors built for climbing

### LZRvision: the only shipping product aimed at home spray walls

<img src="https://lzr.vision/images/home_mobile_hero.JPG" alt="LZRvision drawing green rings around a route's holds on a busy gym wall" width="49%"> <img src="https://lzr.vision/images/home_feature_smartdetection.jpg" alt="A climber's hand on a hold inside a green laser ring" width="49%">

<img src="https://lzr.vision/images/home_feature_anywall.jpg" alt="A green laser ring beside a wooden hold on a home wall" width="32%">

*Photos: [lzr.vision](https://lzr.vision/)*

| | |
|---|---|
| What it is | A small galvo (mirror-scanning) laser with a built-in camera. It matches the wall to a reference photo, then draws rings around the selected climb's holds. |
| Laser | Off-the-shelf **5 mW, Class 3R**. Green by default; red or blue possible, with RGB planned ([creator's post](https://www.mountainproject.com/forum/topic/202116707/laser-route-projector-for-home-and-gym-spray-walls)) |
| Capacity | **About 10 holds before flicker.** 30+ holds work if you accept flicker, or switch to dots or underlines. |
| Apps | Crux, plus Moon, Kilter, Tension, Decoy, Boardsesh and BoulderBook ([site](https://lzr.vision/)). Boardsesh merged **"Lit by a wall device"** support on 2026‑11‑05 with LZRvision as the first device ([PR #7271](https://github.com/boardsesh/boardsesh/pull/7271)). |
| Setup | Point it at the wall, join Wi‑Fi, image match and calibration, pick a climb. Runs on wall power; battery in development. |
| Price and status | Kickstarter **funded: $16,850 from 49 backers** (~$343 average pledge) ([PledgeBox](https://www.pledgebox.com/projects/lzrvision-a-board-climbing-led-alternative), [Kickstarter](https://www.kickstarter.com/projects/lzrvision/lzrvision-a-board-climbing-led-alternative)). The creator put parts at ~$180 a unit. No list price; international shipping not offered yet. |
| Fit for the Yuzu Board | Works only through Crux or Boardsesh, so routes would live in those apps as well as the Yuzu Board. There's no documented local API to send it holds from this app. |

**Verdict:** the cheapest turnkey option and pleasingly purpose-built. Its limits are a single colour, about ten holds and a one-person company.

### Student and research prototypes (not for sale, but useful designs)

- **BetaSpray** (UIUC ECE 445): up to four laser pointers on 2‑axis servo gimbals, an ESP32 and a Pi camera, with OpenCV finding hold centroids. The team listed a DLP pico projector as the fallback "if laser precision or eye safety" became a problem. [Project page](https://courses.grainger.illinois.edu/ece445/project.asp?id=12312)
- **betaCube** (DFKI): a camera and projector unit that recognises holds and projects a marker around each. It's the research version of the projector approach. [Paper (PDF)](https://www.dfki.de/fileadmin/user_upload/import/8245_betaCube.pdf)
- **Augmented Climbing Wall** (Aalto University, which became Valo Motion): projector, depth camera and PC. It noted that "occlusion is not a big problem if projected objects do not appear directly where the climber is" and that the projector must be bright enough to pick out individual holds. [CHI 2014 paper](https://users.aalto.fi/~hamalap5/publications/kajastila_paper_chi_wip_2014_camera_ready.pdf)
- **ClimbAR**: a Kinect and OpenCV climbing game with a hold detector. [GitHub](https://github.com/patxu/ClimbAR)

---

## Option B: general-purpose scanning lasers

These are laser-show projectors. You'd write a small program that turns a route into a list of points and streams it to the laser.

### LaserCube (Wicked Lasers / LaserOS)

<img src="https://www.laseros.com/wp-content/uploads/2021/08/product-5-scaled-1-1-1024x683-1.jpg" alt="LaserCube WiFi held in a hand" width="49%"> <img src="https://www.laseros.com/wp-content/uploads/2026/06/ultra-gallery-1216x1216-01.jpg" alt="LaserCube Ultra with its mounting bracket" width="40%">

*Photos: [laseros.com](https://www.laseros.com/us/lasercube/)*

| Model (official store, Nov 2026) | Price | Notes |
|---|---|---|
| LaserCube WiFi 1.2 W | $1,499 | RGB, Wi‑Fi and battery. 25–35 kpps @ 8° (sources disagree), max scan ≈ 26° ([manual](https://manuals.plus/laserdock/cube2ultra-laser-cube-manual), [reseller specs](https://pssl.com/products/wicked-lasers-lasercube-wifi-1-2w-laser-projector)) |
| LaserCube WiFi 2.5 W | $1,799 | Same body, more power |
| LaserCube Ultra MK2 6 W | $2,799 | Adds DMX, ILDA and MIDI. 35 kpps @ 7°, max scan ≈ 37° |
| LaserCube Ultra MK2 10 W | $3,699 | |

Older retail listings show the Ultra 2.5 W at $2,699–2,799 and the Ultra 7.5 W at $3,599.

**Pros:** full RGB, so the start, hand, foot and finish colours are possible. Polished hardware, and it's networked.
**Cons:** every model is **Class 4 (≥1.2 W)** and aimed at a wall people climb on (see [Safety](#safety-and-regulations)). The narrow scan angle means it needs 18–26 ft of distance. Wicked Lasers publishes no official SDK; open-source drivers reverse-engineered the protocol (below). It's priced like a good projector without a projector's advantages.

### Build your own: DAC, galvos and a low-power diode

<img src="https://bitlasers.com/wp-content/uploads/2019/10/main_withlabels.png" alt="Helios laser DAC with labelled ports" width="45%">

*Photo: [Bitlasers](https://bitlasers.com/)*

| Part | Price | Notes |
|---|---|---|
| [Helios Laser DAC](https://bitlasers.com/) (USB to ILDA) | **$114** (maker's store), ~$198 at third parties | Recommended for beginners by [Liberation's docs](https://docs.liberationlaser.com/hardware/compatible-lasers-and-controllers-dacs). Official [SDK](https://github.com/Grix/helios_dac) is a C library with Python examples. A HeliosPRO is $229, and an OpenIDN network adapter $109. |
| [Ether Dream 4](https://ether-dream.com/) (Ethernet to ILDA) | ~$229 (one listing) | Network DAC, so it can live on the wall away from the computer |
| 20 kpps galvo kit (mirrors, drivers, PSU) | ~$85–225 | e.g. [this listing](https://www.fruugo.ca/20kpps-laser-scanning-galvo-galvanometer-scanner-set-for-dj-laser-light-show/p-291806489). Manuals often missing and drivers run warm, so add a fan ([Hackaday log](https://hackaday.io/project/165977/log/164412-looking-at-the-galvos)). |
| Laser module | tens of dollars | Keep it **≤5 mW (Class 3R)**, as LZRvision does |

**Software that already speaks to these DACs:**

- [`laser-dac`](https://docs.rs/laser-dac) (Rust, maintained): Helios, Ether Dream, LaserCube WiFi and USB, and IDN, with a built-in simulator so you can develop without hardware.
- [`@laser-dac/*`](https://github.com/Volst/laser-dac/) (Node/TypeScript, MIT): Ether Dream, Helios, LaserCube WiFi, Laserdock and a web simulator. Its README now marks it **legacy/unmaintained** and points to the Rust crate.
- [Helios SDK](https://github.com/Grix/helios_dac): call the shared library from Python with `ctypes`. Only the Windows binary is guaranteed current, so build your own on macOS.

**The point budget:** at 30 kpps and a 30 fps refresh you get about 1,000 points per frame. A smooth ring plus the blanked jump to the next hold costs ~40–50 points, so **~20 holds** fit before flicker on good galvos, and fewer on cheap 20 kpps ones (LZRvision reports ~10).

---

## Option C: a video projector plus projection mapping

> ✅ **Chosen.** Two short-throw laser projectors, overlapped. Part 2 covers [which model](#choosing-the-pair) and [where they go](#where-to-put-them).

The projector shows a black image with coloured rings exactly where the holds are. The room stays dark everywhere else, so the rings pop.

### Projector shortlist

| | Model | Light | Throw | Portrait / 360° | Tech | Price (Nov 2026) |
|---|---|---|---|---|---|---|
| <img src="https://www.projectorcentral.com/images/projectors2/img12105.jpg" alt="Optoma ZH450ST" width="130"> | ✅ **[Optoma ZH450ST](https://www.projectorcentral.com/Optoma-ZH450ST.htm)** | 4,200 lm rated, 4,296 lm measured; 1080p | **0.50:1** | 360° ([review](https://www.projectorreviews.com/optoma/optoma-zh450st-short-throw-4200-lumens-laser-projector-review/)); portrait per a [retailer](https://www.deploydepot.com/products/optoma-zh450st-3d-short-throw-dlp-projector-16-9-wall-mountable-portable-white-zh450st) | DLP, laser phosphor, 30k h, **IP6X sealed engine** | ~$1,999 street; $2,100–2,410 at dealers |
| <img src="https://www.projectorcentral.com/images/projectors2/img11996.jpg" alt="Epson PowerLite L210SF" width="130"> | **[Epson PowerLite L210SF](https://www.projectorcentral.com/Epson-PowerLite_L210SF.htm)** | 4,000 lm white **and colour**, 1080p | **0.45:1** | Yes, landscape to portrait ([Epson](https://epson.com/p/V11HA75020)) | 3LCD, laser, 20k h, filtered intake | ~$1,683–1,717 |
| <img src="https://www.projectorcentral.com/images/projectors2/img12876.jpg" alt="BenQ LH830ST" width="130"> | **[BenQ LH830ST](https://www.benq.eu/en-eu/business/projector/lh830st.html)** | 4,000 lm, 1080p | **0.50:1** | Yes ([BenQ](https://www.benq.eu/en-eu/business/projector/lh830st.html)) | DLP, laser, 20k h. Has Corner Fit and geometric correction. | ~$1,999–2,099 |
| <img src="https://www.projectorcentral.com/images/projectors2/img12652.jpg" alt="Epson PowerLite L690SE" width="130"> | **[Epson PowerLite L690SE](https://www.projectorcentral.com/Epson-PowerLite_L690SE.htm)** | 6,000 lm white **and colour**, WUXGA | **0.50–0.70:1 zoom**, lens shift ±50% V / ±20% H | Not listed; check | 3LCD, laser, 20k h | $5,144 (Epson.com) – $5,710 |
| <img src="https://www.projectorcentral.com/images/projectors2/img12111.jpg" alt="ViewSonic LS740HD" width="130"> | **[ViewSonic LS740HD](https://www.projectorcentral.com/ViewSonic-LS740HD.htm)** | 5,000 lm, 1080p | 1.13–1.47:1 (needs ~23–25 ft) | Yes | DLP, laser, 20k h | ~$1,099–1,155 |
| <img src="https://www.projectorcentral.com/images/projectors2/img12973.jpg" alt="Epson EpiqVision Mini EF-22" width="130"> | *Counterexample:* [Epson EF‑22](https://www.projectorcentral.com/epson-epiqvision_mini_ef-22r.htm) | 1,000 lm | ~1.0:1 | Swivel stand | 3LCD, laser | $999 MSRP. **Discontinued Jun 2026**; refurbished ~$499 |

*Product photos: [ProjectorCentral](https://www.projectorcentral.com/).*

The EF‑22 is there to show why a pretty living-room mini projector won't do. At 10 ft it fills only ~10 ft across, and at 40 lux the rings vanish once a light is on.

### What matters when choosing

- **A laser light source**, not a lamp: it turns on instantly with no warm-up and lasts 20,000+ hours, which suits flicking it on for one climb.
- **Colour brightness.** The rings are coloured (green, orange, violet, yellow), not white. Single-chip DLP projectors are rated on white and can be noticeably dimmer on colours. 3LCD (Epson) rates colour and white the same.
- **Mounting at any angle.** The projectors hang upside down and tip steeply toward an overhang, which is only safe on models rated for 360° installation.
- **Lens shift** (Epson L690SE) lets you place the projector off-centre without losing pixels to digital keystone. Without it, the geometry gets fixed in software, which the calibration step does anyway.
- **Shadows.** A single projector leaves the climber's shadow on the wall behind them. A second projector from another angle fills it in; [Part 2](#how-two-projectors-cancel-shadows) measures how much.
- **Five planes.** The ceiling, the side panels and the footboard sit at different angles from the main panel. A single four-corner keystone can't line them all up. Each panel needs its own corner pin.

### Projection-mapping software

| Tool | Price | Notes |
|---|---|---|
| **Custom page in the app** ([Part 2](#how-it-plugs-into-the-yuzu-board)) | $0 | The fit for this project: the hold coordinates already live in this app's database |
| [MadMapper](https://madmapper.com/) | ~€479 licence or ~€39–44/month ([third-party listing](https://www.techjockey.com/us/compare/madmapper-vs-heavym)) | The standard dedicated mapper; handles per-surface quads and mesh warps |
| [HeavyM](https://heavym.net/) | Live ~$229, Pro ~$499 (same listing) | The easiest of the three for beginners |
| [Resolume Arena](https://resolume.com/shop) | €799 one-time, 12 months of updates | VJ software; mapping is in Arena's Advanced Output (Avenue lacks it) |
| [TouchDesigner](https://derivative.ca/UserGuide/Licensing) | Free non-commercial (**output capped at 1280 × 1280**, below 1080p); $600 commercial | Very capable, but the free cap bites at 1080p |
| [ofxPiMapper](https://ofxpimapper.github.io) / PocketVJ | Free, open source | Raspberry Pi mapping, but documented only up to the Pi 3B+ ([overview](https://www.hackster.io/news/what-you-need-to-know-about-projection-mapping-on-a-raspberry-pi-367f149593e1)) |
| ~~Lightform LF2~~ | n/a | Company closed **Aug 2022**, cloud and support gone. LF2 units also need a fire-risk firmware fix, so avoid used ones ([sunset FAQ](https://guide.lightform.com/hc/en-us/articles/4417512435731-Sunset-FAQ)). |

---

## Commercial gym systems

### ValoClimb (Valo Motion)

<img src="https://cdn.prod.website-files.com/6332e8190a1aad33e26397e8/682afc5292f3d707bea09e94_VC_gallery1.avif" alt="ValoClimb game projected on a climbing wall, with the floor-pole projector on the left" width="60%">

<img src="https://cdn.prod.website-files.com/6332e8190a1aad33e26397e8/682b04b83cb85e4980058f12_VC_setup1.avif" alt="ValoClimb floor-pole projector configuration" width="40%"> <img src="https://cdn.prod.website-files.com/6332e8190a1aad33e26397e8/682b04b7eed1997ca897f48d_VC_setup2.avif" alt="ValoClimb ceiling-mounted projector configuration" width="40%">

*Photos: [valomotion.com/valoclimb](https://valomotion.com/valoclimb). Left: floor-pole mount. Right: ceiling mount.*

- Projection plus motion tracking that turns a wall into games (the original Aalto "Augmented Climbing Wall"). It's in 40+ countries and sold through Entre-Prises and Clip 'n Climb ([Blooloop](https://blooloop.com/technology/news/valo-motion-partners-entre-prises/)).
- Hardware: **L1 (7,000 lm) or L2 (6,000 lm, dust-filtered) projector units**, wired internet, indoors only. It needs **4.5 × 5 m of floor and a 3.5 m ceiling**.
- **Price on request only.** It's built and priced for gyms and entertainment centres and focuses on games, not your own route list. It does show that a single projector aimed at a climbing wall works, and that gyms take dust seriously enough to sell a filtered model.

### Others

- **Generic "interactive climbing projection" boxes** (game PC, laser projector and 3D sensor, for 2.6–4.5 m wide walls), e.g. [KL Multimedia](https://www.klmultimedia.com/Interactive-Climbing-Wall.html). These are game-oriented too.
- **Luxov** (Volx Group, France) builds *connected holds*, not projection ([overview](https://de.slideshare.net/witekio/luxov-connected-climbing-wall)).

---

## Not projection: LED boards

These are included for comparison, because they're what "lit holds" usually means.

- **Kilter, Tension and other Aurora-powered boards** light an LED at every hold position from an app. Their LED kits are tied to fixed layouts: the Kilter 8×12 Homewall has 630 LEDs. A Kilter Full Ride lists at ~$5,372 before frame, mat and shipping, and ~$7,000 complete is commonly quoted ([Setter Closet](https://settercloset.com/products/kilter-board-fullride-complete), [Kilter](https://kiltergrips.com/collections/kilter-board)).
- **DIY LEDs:** [PeggyBoard](https://github.com/PegorK/PeggyBoard) (Raspberry Pi, a WS281x strip, a web route planner, MIT). The open-source [Boardsesh](https://github.com/boardsesh/boardsesh/pull/7377) app now has a spray-wall LED editor that links each hold to an LED.
- **Why they fit poorly here:** Yuzu Board holds sit at **free x, y positions**, on side panels and the ceiling with no t-nuts, and they move at every reset. A light fixed behind a t-nut can't follow a hold placed between t-nuts or on a panel without them. Projection lights wherever the app says a hold is.

---

## Side-by-side

| | LZRvision | DIY galvo laser (≤5 mW) | LaserCube | ✅ Short-throw projector (×2) | Long-throw projector | LED per hold |
|---|---|---|---|---|---|---|
| Up-front cost | ~$350 (backer average) | ~$300–450 | $1,499–3,699 | ~$2,000 each; ~$4,700 for the full build | ~$1,100 | $1,000s + wiring |
| Light on each ring | ~100 lux, shared between holds | ~100 lux, shared | High, but you'd turn it down for safety | ~70–400 lux per unit at 4,000 lm, any number of holds; ×2 where both reach | ~200–230 lux | Bright |
| Four role colours | No (green; RGB planned) | Only with an RGB module | Yes | **Yes** | Yes | Usually |
| Holds at once | ~10 | ~10–20 | ~20 | **Unlimited** | Unlimited | Unlimited |
| Distance from wall | Unknown | Depends on galvo angle | 18–26 ft | **12–16 ft** on this 45° board | 23–25 ft | n/a |
| Shadows | Yes | Yes | Yes | **Mostly filled** by the second unit | Yes | **None** |
| Eye safety | Class 3R | Class 3R | **Class 4** | Projector risk group; don't stare into the lens | Same | None |
| Follows free-placed holds | Yes (camera) | Yes | Yes | **Yes** | Yes | No |
| Effort to drive from this app | Through Crux or Boardsesh only | Medium (Python/Rust service) | Medium | **Low (a web page)** | Low | High |

---

## Safety and regulations

- **Laser classes:** **Class 3R** (≤5 mW visible) carries a low risk of injury from brief exposure. **3B** (up to 500 mW) and **Class 4** (>500 mW, every LaserCube) can injure the eye instantly, including from strong reflections.
- **The audience is on the screen.** A climber on the wall is inside the area being scanned, and on an overhang they often look back toward the mat and the projector. A ring drawn next to someone's head passes the beam across their eyes. A Class 3R moving beam is low risk. A watt-class laser here is "audience scanning", which pros only do with careful measurement. Software power limits aren't a safety system.
- **US rules:** selling or operating **Class 3B or 4 laser light show** equipment needs an **FDA variance** (Form 3147) ([FDA](https://www.fda.gov/radiation-emitting-products/home-business-and-entertainment-products/laser-light-shows)). Third-party guides say a show at home for family and friends falls outside FDA jurisdiction, but others say buying one still requires a variance. That's unresolved ([lasershowsafety.info](https://lasershowsafety.info/faq.html), [laserpointersafety.com](https://laserpointersafety.com/rules-general/us-regulatory-agencies/us-regulatory-agencies.html)). The [ILDA safety one-pager](https://www.ilda.com/resources/Safety/Laser_Light_Show_Safety_Overview_One_Page-v7-ILDA-logo.pdf) is a good primer.
- **Video projectors with laser light sources** carry the usual "don't look into the lens" warnings ([Epson example](https://files.support.epson.com/docid/cpd6/cpd64112/source/notices/reference/ebpq2213b_2220b/laser_safety_info_ebpq2213b_2216w.html)). Aimed at the wall from 12+ ft, that's ordinary classroom-projector caution; [Risks and mitigations](#risks-and-mitigations) covers the specifics for this build.

---

# Part 2: Deep dive into the chosen setup

## Why this setup

- **One projector does the lighting well.** It lights any number of holds in the four role colours, follows holds wherever they're placed, and stays out of laser-safety territory.
- **Two projectors fix the one weakness.** A single projector leaves the climber's body shadow on the wall behind them, often over the holds right around them. A second projector aimed from the other side lights those spots, because its shadow falls somewhere else.
- **The narrow room helps.** With side walls only ~13 ft apart, a projector on each sits close to the wall's edges and about 9 ft apart. That wide spread is exactly what pushes the two shadows apart.

Assumptions used throughout Part 2: main panel overhanging **45°** (40° checked too), an 8" kicker/footboard, side panels in the main panel's plane, a room **~13 ft wide** with a **~9 ft ceiling**, and projectors with a 0.5:1 throw and 116% offset (the Optoma ZH450ST's figures). The numbers come from a small geometric model of the wall, the projectors and a climber. Re-run it with your exact measurements before drilling.

## How two projectors cancel shadows

Both projectors show the **same** image, aligned so their rings land on top of each other. Anywhere one is blocked, the other still lights the wall at half brightness. Only where **both** are blocked does it go dark. Research calls this *redundant* or *passive virtual-rear* projection:

- Sukthankar et al. (CVPR 2001) showed that redundant illumination from projectors at different positions mutes shadows. They added cameras to boost the unblocked projector on the fly ([CMU](https://www.ri.cmu.edu/publications/dynamic-shadow-elimination-for-multi-projector-displays)). Cham et al. (2003) also blanked the light falling on the person ([paper](https://mlanthology.org/cvpr/2003/cham2003cvpr-shadow)).
- Summet et al. (Georgia Tech) tested it with people. Passive two-projector setups reduce the effects of shadows, but leave two half-power shadows and put more light on the person. Users disliked light in their faces ([study](https://faculty.cc.gatech.edu/~summetj/papers/sp408-summet.pdf), [thesis](https://repository.gatech.edu/entities/publication/1ce61bfe-85d9-4747-abfb-3b3285108253)). Here the climber faces the wall and the image is almost all black, so only rings that happen to land on them light them up.

![Side view: a projector hangs upside down on the side wall about 13–15 ft out and 6–7 ft up, nose tilted up 25–30°, lighting the 45° wall from the kicker to the top. From above: one projector on each side wall; the climber casts two offset shadows, each still lit by the other projector, leaving only a small dark patch behind the torso.](img/projector-placement.svg)

**What the model shows.** The climber is mid-problem on the 45° board: torso, head, arms to two handholds, bent legs to two footholds. The torso's centre line is 14" off the wall. Area counted is the middle 101" × 109" of the main panel.

| Projectors | Fully dark wall area | Lit by one projector only |
|---|---|---|
| One, centred, 13 ft out, 7 ft up | ~1,400 in² (a ~37" square) | n/a |
| Two on the side walls, 13 ft out, 7 ft up | **~190 in²** (a ~14" square), **−86%** | ~3,000 in² |
| Two on the side walls, 15 ft out, 6 ft up | **~290 in²** (~17" square), **−80%** | ~2,600 in² |

What's left dark is a patch about the size of the middle of the torso, directly behind it. That's where the climber's body already is, so it rarely hides a hold they're looking for. A climber pressed close to the wall (10" off) leaves a bigger patch, and one hanging further out (18") leaves a smaller one. Across those body positions and the spots in the next table, the dark area ranges from about 85 to 590 in² with two projectors, versus 1,050–1,520 in² with one.

**The trade-off:** projectors closer to the wall and higher up see the climber from more different angles, so less is dark. But their images are more stretched and less even (next section). Farther back and lower is more even, with slightly bigger shadow patches.

**Brightness:** wherever both projectors reach, a ring gets both units' light, about 2×. In one projector's shadow it gets 1×. Rings stay readable in a half-shadow; they're just dimmer.

## Where to put them

### The finding that sets everything: the top of the wall leans toward you

From a side wall 10 ft out and 4 ft up, the wall spans about **86°** from the kicker's far bottom corner to the near top corner. A 0.5:1 lens covers at most ~85° corner to corner, so **no aim takes in the whole wall from there**. Epson's slightly wider 0.45:1 lens doesn't change this. Each projector has to sit further back, and the closer it is, the higher it must go:

| Out from the wall base | Height | Sharpness, px/in (worst–best) | Light angle on the wall | Light per projector at 4,000 lm, lux (dimmest–brightest) | Mount: nose up / turned in | Dark area with two (vs one) |
|---|---|---|---|---|---|---|
| ≤ 11 ft | any | doesn't fit (11 ft only just, with no margin, right at the ceiling) | | | | |
| 12 ft | 8 ft (at the ceiling) | 4.0–17.8 | 32–79° | 48–947 | +20° / 18° | 89 in² (vs 1,328) |
| 13 ft | 7 ft | 4.8–14.3 | 26–74° | 69–611 | +25° / 15° | 189 in² (vs 1,396) |
| **14 ft** | **6–7 ft** | **4.9–11.9** | **21–73°** | **73–425** | **+26–29° / 11–12°** | **248–279 in² (vs ~1,420)** |
| 15 ft | 5–6 ft | 5.5–10.5 | 16–68° | 91–329 | +30–34° / 8° | 291–351 in² (vs ~1,440) |
| 16 ft | 5 ft | 6.0–9.7 | 16–64° | 108–278 | +35° / 5° | 407 in² (vs 1,437) |

*"Light angle" is measured from straight-on. The high end is at the bottom of the main panel on the side farthest from that projector, just above the kicker, where light skims the surface. That corner is the other projector's near side, so between them it still gets decent light. Skimmed rings come out dimmer, but the app draws them in wall inches, so their shape stays right.*

**Recommendation: about 14 ft out from the wall base, 6–7 ft up, one on each side wall.** That's the most balanced spot: brightness varies about 5× across the wall rather than 9–20× from 12–13 ft, every inch gets about 5 pixels or more, and the mount is at or above head height. If the room is only 12–13 ft deep, go higher: 13 ft out at 7 ft, or 12 ft out tight under the ceiling. If it's 15–16 ft deep, lower and further back gives the most even picture.

- **Mounting angle:** upside down (ceiling-mount style), nose tipped up about 25–30°, turned in about 10–15° toward the centre. The model tried upright and portrait mounts too. Upright gives very uneven sharpness, and portrait never covers this almost-square wall.
- **A 40° board** is a little harder, because its top is higher. It needs 12 ft only at 8 ft up, about 14 ft at 7 ft up, or 15–16 ft at 5–6 ft up, with similar numbers.
- **The ceiling is a poor mount for the main job.** From the ceiling, only spots ≥14 ft out cover the wall, and they sit near the centre line, which gives no shadow separation. Use the ceiling for cable runs.
- **The 18" ceiling panel falls outside the image** from all of these spots, assuming it continues the main panel's angle. Only from ~15 ft out and 7 ft up can one projector tip up to take in the main panel and the ceiling panel, leaving the kicker to the other. Its real angle isn't in the app, so measure it and decide whether holds up there need light. If they do, those holds get one projector instead of two.
- **Clear of falls and people:** on a 45° board falls land within roughly 0–9 ft of the wall base, so side-wall mounts at 12+ ft are outside that. Someone standing on the mat between a projector and the kicker will block it. The other projector covers that too.

## Choosing the pair

| | ✅ Optoma ZH450ST | Epson PowerLite L210SF | BenQ LH830ST |
|---|---|---|---|
| Price each (Nov 2026) | ~$1,999 | ~$1,683–1,717 | ~$1,999–2,099 |
| Brightness | 4,200 lm rated; **4,296 measured** in Bright (tints green-blue), 3,228 in Vivid | 4,000 lm white **and** 4,000 colour; no lab measurement found | 4,000 lm rated; no lab measurement found |
| Imaging | 1080p single-chip DLP | 1080p 3LCD | 1080p single-chip DLP |
| Throw / offset | 0.50:1 (0.498 in its throw table), 116% | 0.45:1, digital zoom only; offset not listed | 0.50:1 (0.496), 116% |
| Mounting | 360° | 360°, landscape to portrait | 360° and portrait |
| Dust | **IP6X sealed light engine** | Filtered intake (replaceable filter); sealing not stated | Not stated |
| Network control | LAN with **PJLink**, RS‑232, Crestron, AMX, Extron | LAN, RS‑232, Wi‑Fi option; PJLink not confirmed on its pages | LAN, RS‑232; PJLink not confirmed |
| Geometry tools | ±30° keystone, 4-corner | Keystone, geometric correction, edge blending | Corner Fit, geometric correction |
| Fan noise | ~29 dB typical, 36 dB max | 37 dB (27 dB Eco) | Not found |
| Weight | **6.6 lb** | 10.4 lb | 7.5 lb |
| Light source life | 30,000 h | 20,000 h (30,000 Eco) | 20,000 h (30,000 Eco) |

<img src="https://www.projectorreviews.com/wp-content/uploads/2024/10/Optoma_ZH450ST_PJBProdShot1.webp" alt="Optoma ZH450ST, front view showing its short-throw lens" width="48%"> <img src="https://www.projectorcentral.com/images/projectors2/img11996.jpg" alt="Epson PowerLite L210SF" width="30%">

*Photos: [Projector Reviews](https://www.projectorreviews.com/optoma/optoma-zh450st-short-throw-4200-lumens-laser-projector-review/) (Optoma), [ProjectorCentral](https://www.projectorcentral.com/Epson-PowerLite_L210SF.htm) (Epson).*

**Pick: two Optoma ZH450ST.**
- **Chalk:** the dust-tight IP6X engine matters in a room full of chalk.
- **Known quantities:** brightness is measured independently, and its PJLink network control is confirmed.
- **Easy to hang:** it's the lightest of the three on a wall arm.
- **Matches the model:** its published throw (0.498:1) and offset are exactly what the placement model used.

Trade-offs: like any single-chip DLP, its colours are dimmer than its white. It has no lens shift, which doesn't matter because the software does the geometry. The reviewer found the focus touchy and the brightest mode a little green-blue. Buy **two identical units** so colour and brightness match where they overlap.

**Runner-up: two Epson L210SF** (about $560 less for the pair). 3LCD keeps coloured rings as bright as white, and Epson confirms portrait and 360° mounting. Against it: an air filter that chalk will clog, so plan on regular cleaning; it's heavier and louder; and its offset isn't published, so re-check placement before buying.

## Mounting and protection

<img src="https://media.startech.com/cms/products/gallery_large/projwallmnt.main.jpg" alt="StarTech PROJWALLMNT telescoping short-throw projector wall arm" width="40%">

*Photo: [StarTech.com](https://www.startech.com/en-us/display-video-products/projwallmnt)*

- **What the mount has to do:** hold the projector upside down, 1.5–2 ft off the side wall, nose up ~25–30°, turned in ~10–15°, at 6–7 ft high.
- **Example: [StarTech PROJWALLMNT](https://www.startech.com/en-us/display-video-products/projwallmnt)** (~$200–230), a short-throw wall arm. It reaches 16.5–27.7" from the wall, holds 33 lb, and has a lockable ball joint with 360° swivel and ±25° tilt, plus ±5° in the arm. That covers the 13–14 ft spots (+25–29°). Further-back spots need +30–35°, so add a wedge between plate and projector or choose a mount with more tilt.
- **Fix it into studs** and add a **safety cable** from the projector to the wall. Laser projectors are heavy enough to hurt someone if a mount lets go.
- **Chalk:** a sealed engine keeps dust off the optics inside, but chalk still settles on the lens and gets pulled through the cooling vents. Blow the lens off and wipe it with a microfibre cloth every few weeks, keep vents clear, and brush holds away from the projectors. Dust ratings are tested with talc, not chalk ([BenQ on IP5X and IP6X](https://benq.eu/en-eu/business/resource/trends/why-dustproof-is-vital-in-a-projector-world.html)), so a rating isn't a guarantee.
- **Airflow:** 360° rating covers upside-down and tilted mounting, but leave a hand's width around the intake and exhaust, and don't box the projector in.

## Driving two projectors

| | Raspberry Pi 5 | The Mac running app.py | Mini PC |
|---|---|---|---|
| Cost | ~$110 for 4 GB after the 2026 memory price rises (reports range $85–110) + power supply, case, card | $0 extra | Now about the same as a Pi 5 ([Tom's Hardware](https://www.tomshardware.com/raspberry-pi/raspberry-pi-and-mini-pc-home-lab-prices-hit-parity-as-dram-costs-skyrocket-price-hikes-force-hobbyists-to-weigh-up-performance-versus-power-consumption)) |
| Video outputs | Two micro-HDMI, 4K60 each | Depends on the model: many MacBook Airs drive one external display | Two or three, varies |
| Where it sits | On the ceiling between the projectors: short cables | Wherever the Mac lives: long cables to both projectors | On the ceiling or a shelf |
| Downsides | Running a separate kiosk window per output is fiddly under Wayland. One report describes [dual-HDMI detection failing at boot](https://github.com/raspberrypi/linux/issues/7148) on a recent OS. | The wall goes dark whenever the Mac sleeps or someone takes it | Bigger, uses more power |

**Pick: a Raspberry Pi 5 (4 GB) on the ceiling midway between the projectors.** Run one full-screen Chromium kiosk window across both outputs (a 3840 × 1080 desktop). Point it at `http://<Mac's IP>:5050/projector`, a page that draws the left projector's image in the left half and the right's in the right half. That one window sidesteps per-output window placement. If the Pi fights you, a mini PC runs the same page.

**Cabling:** two micro-HDMI to HDMI cables, ~10 ft each (passive is fine at 1080p over that length), and power at each mount. The ZH450ST has Ethernet but no Wi‑Fi, so put a small switch next to the Pi with one cable back to the router. The Pi and both projectors plug into it.

## Power and control

- **PJLink** is a plain-text network protocol (TCP port 4352) that most projectors speak. With it, the app's server can turn both projectors on when someone taps "Show on wall" and off after, say, 20 minutes without a change. Python options: [pypjlink](https://pypi.org/project/pypjlink/) (old, Python ≤3.5), its fork [pypjlink2](https://pypi.org/project/pypjlink2/1.2.2/) (adds Optoma support), [aiopjlink](https://pypi.org/project/aiopjlink/) (asyncio), or ~30 lines of socket code.
- Give each projector a fixed IP (a DHCP reservation) and set a PJLink password. RS‑232 is the fallback.
- **Switching on and off is free:** the laser light source is rated 30,000 hours (40 years at two hours a day) and has no lamp to wear out or warm up.

## Alignment and calibration

Each projector needs its own map from wall inches to its pixels, **one per flat surface**:

- the main panel, plus the side panels if they really sit in its plane;
- the footboard;
- the ceiling panel.

That's up to six maps (2 projectors × 3 surfaces). Each is a homography, a 3×3 matrix.

1. **Collect points.** A calibration page shows a crosshair; you nudge it onto a known t-nut and confirm. The app already knows every t-nut's position from `geometry.py`. Use ~9 spread across the main panel and 3–4 on the footboard. Side panels and the ceiling have no t-nuts, so use their corners.
2. **Fit.** A least-squares fit (OpenCV's `findHomography`, or ~40 lines of JavaScript) over more than four points averages out small nudging errors.
3. **Check.** Both projectors draw the whole t-nut grid as dots. Matching dots on every hole means they agree.

**How exact it needs to be:** at the recommended spot each projector puts 5–12 pixels into every inch, so one pixel is about 0.1–0.2". Aim for the two projectors' rings to land within **¼"** of each other so they read as one ring. Further out they show as a doubled or blurred ring, which is the sign to recalibrate. Recheck monthly, or after anything bumps a mount.

**Brightness balancing:** each projector is several times brighter on the near part of the wall than the far part. The calibration already says how stretched each spot is, so the page can dim rings where a projector is close. Overlapped, the wall then looks even.

**Later upgrade:** fully automatic calibration with a webcam. Project [Gray-code patterns](https://docs.opencv.org/4.x/d7/d9c/graycodepattern_8hpp.html), read them back with OpenCV, and find printed markers at the panel corners. Worth it only if manual calibration becomes a chore.

## How it plugs into the Yuzu Board

*This is a sketch, not a build. Nothing in the app has changed yet.*

What already exists and gets reused:

| Need | Already in the app |
|---|---|
| Where each hold is | `holds.x`, `holds.y` in inches, plus `size` (longest side, inches), `rotation` and an optional hold photo (`schema.sql`, `/api/holds`) |
| Which holds a climb uses, and their roles | `route_holds.role` (`/api/routes/<id>`) |
| Panel shapes and the t-nut grid | `geometry.py`, served at `/api/board` |
| Ring look per role | `RING_BANDS` in `static/js/board.js` (a dark gap, then one or two coloured rings; bold for hands, thin for feet, double for start and finish) |
| Role colours | `--start`, `--hand`, `--foot`, `--finish` in `static/css/app.css` |

What would be new:

1. **A `/projector` page.** A black full-screen canvas with one half per projector. For the climb on the wall, it draws each hold's rings from `RING_BANDS` in **inches instead of screen pixels**. Rings follow the hold photo's outline (or a circle from `size`) in its role colour. Each half applies its projector's per-panel maps and brightness balancing.
2. **"Show on wall"** on route and circuit pages, saved on the server (e.g. `POST /api/wall`). The projector page picks it up by polling or Server-Sent Events. Swiping to the next climb on a phone updates the wall.
3. **A calibration page** (the crosshair flow above), saved in a small table, e.g. `projector_calibration(projector, surface, matrix)`, plus a "show t-nut grid" test button.
4. **PJLink power control** on the server (a new blueprint alongside the others, see [development.md](development.md)): on with the first "Show on wall", off when idle.

## Parts list and cost

| Item | Qty | Each | Total |
|---|---|---|---|
| Optoma ZH450ST | 2 | ~$1,999 | ~$4,000 |
| Short-throw wall arm (e.g. StarTech PROJWALLMNT) | 2 | ~$200–230 | ~$400–460 |
| Raspberry Pi 5 (4 GB) + power supply, case, microSD | 1 | ~$150–175 | ~$150–175 |
| Micro-HDMI to HDMI cable, ~10 ft | 2 | ~$15–25* | ~$30–50 |
| 5-port switch and Ethernet runs | 1 | ~$30–60* | ~$30–60 |
| Safety cables, cable raceway, any new outlets | — | — | ~$30–80* |
| **Total** | | | **≈ $4,650–4,850** |

\* Estimates; not checked against listings. The Epson L210SF pair would bring the total down by about $560.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| The room is shallower than ~12 ft from the wall base | No single 0.5:1 projector then covers the whole wall. Mount as high as the ceiling allows, accept one projector's light on the kicker or the top edge, or add a third unit just for the kicker. |
| Doubled rings (projectors out of alignment) | Least-squares calibration on many t-nuts, rigid stud-mounted arms, and a monthly grid check |
| Chalk on lenses and in vents | Sealed IP6X engines, a regular lens wipe, and keeping chalk buckets and brushing away from the mounts |
| Uneven brightness across the wall | Software brightness balancing and dimmed room lights |
| Coloured rings dimmer than white on DLP | Test the four role colours early; thicken rings or adjust colours for the wall. The Epson 3LCD pair is the fallback. |
| Light in climbers' eyes | Black everywhere except rings; mounts at 6–7 ft, beside the landing rather than in front of it |
| A mount knocked or a projector falling | Mounts outside the fall zone, screwed into studs, with safety cables |
| Ceiling-panel holds hard to reach | Measure its angle; accept one projector's coverage up there |
| Raspberry Pi dual-display quirks | One spanning window, or swap in a mini PC |

## Install and test plan

1. **Measure:** the main panel's angle, the room's depth and width, the ceiling height and the ceiling panel's angle. Re-run the placement numbers with those measurements, since the tables above assume a 13 ft room and a 9 ft ceiling.
2. **Mark the spots:** about 14 ft out and 6–7 ft up on each side wall (or as the model says). Check that a mount there won't be in anyone's way.
3. **Buy one projector first.** Set it on a temporary stand at one spot and show a static image of the t-nut grid from a laptop. Check that it covers the wall, how sharp the focus is, and how readable rings are with the lights on and off. Have someone climb to see the shadow.
4. **Build the projector page** and the manual calibration flow.
5. **Buy the second projector.** Mount both, run power, HDMI and Ethernet, and set fixed IPs and PJLink.
6. **Calibrate both,** check that the grids overlap, and tune brightness balancing.
7. **Climb-test a few problems:** tune ring thickness and colours, and set the idle auto-off.

---

## Sources

**Climbing-specific laser and projection**
- LZRvision: [site](https://lzr.vision/) · [Kickstarter](https://www.kickstarter.com/projects/lzrvision/lzrvision-a-board-climbing-led-alternative) · [PledgeBox summary](https://www.pledgebox.com/projects/lzrvision-a-board-climbing-led-alternative) · [creator's Mountain Project thread](https://www.mountainproject.com/forum/topic/202116707/laser-route-projector-for-home-and-gym-spray-walls) · [Boardsesh PR #7271](https://github.com/boardsesh/boardsesh/pull/7271)
- [BetaSpray (UIUC ECE 445)](https://courses.grainger.illinois.edu/ece445/project.asp?id=12312) · [betaCube (DFKI)](https://www.dfki.de/fileadmin/user_upload/import/8245_betaCube.pdf) · [Augmented Climbing (ACM)](https://dl.acm.org/doi/pdf/10.1145/2559206.2581139) · [Kajastila et al. 2014](https://users.aalto.fi/~hamalap5/publications/kajastila_paper_chi_wip_2014_camera_ready.pdf) · [ClimbAR](https://github.com/patxu/ClimbAR)
- [Stōkt and LEDs (CBJ 2026 Grip List)](https://climbingbusinessjournal.com/2026-grip-list-awards)

**Lasers**
- [LaserCube store (LaserOS)](https://www.laseros.com/us/lasercube/) · [LaserCube manual specs](https://manuals.plus/laserdock/cube2ultra-laser-cube-manual) · [PSSL LaserCube WiFi listing](https://pssl.com/products/wicked-lasers-lasercube-wifi-1-2w-laser-projector)
- [Bitlasers (Helios)](https://bitlasers.com/) · [Helios SDK](https://github.com/Grix/helios_dac) · [Ether Dream](https://ether-dream.com/) · [Liberation: compatible DACs](https://docs.liberationlaser.com/hardware/compatible-lasers-and-controllers-dacs)
- [laser-dac (Rust)](https://docs.rs/laser-dac) · [@laser-dac (Node, legacy)](https://github.com/Volst/laser-dac/)
- [20 kpps galvo kit listing](https://www.fruugo.ca/20kpps-laser-scanning-galvo-galvanometer-scanner-set-for-dj-laser-light-show/p-291806489) · [Hackaday: looking at the galvos](https://hackaday.io/project/165977/log/164412-looking-at-the-galvos)

**Projectors**
- ProjectorCentral: [Optoma ZH450ST](https://www.projectorcentral.com/Optoma-ZH450ST.htm) · [Epson L210SF](https://www.projectorcentral.com/Epson-PowerLite_L210SF.htm) · [BenQ LH830ST](https://www.projectorcentral.com/BenQ-LH830ST.htm) · [Epson L690SE](https://www.projectorcentral.com/Epson-PowerLite_L690SE.htm) · [ViewSonic LS740HD](https://www.projectorcentral.com/ViewSonic-LS740HD.htm) · [Epson EF‑22](https://www.projectorcentral.com/epson-epiqvision_mini_ef-22r.htm) · [projection calculator](https://www.projectorcentral.com/projection-calculator-pro.cfm)
- [Projector Reviews: Optoma ZH450ST](https://www.projectorreviews.com/optoma/optoma-zh450st-short-throw-4200-lumens-laser-projector-review/) (measured brightness, IP6X, PJLink, noise)
- Makers: [Optoma ZH450ST](https://www.optoma.com/us/product/zh450st/) · [Epson L210SF](https://epson.com/p/V11HA75020) · [BenQ LH830ST](https://www.benq.eu/en-eu/business/projector/lh830st.html) · [Epson L690SE](https://epson.com/p/V11HB36020) · [ViewSonic LS740HD](https://www.viewsonic.com/us/products/ls740hd-5-000-ansi-lumens-1080p-laser-installation-projector.html)
- [Deploy Depot: ZH450ST portrait listing](https://www.deploydepot.com/products/optoma-zh450st-3d-short-throw-dlp-projector-16-9-wall-mountable-portable-white-zh450st) · [BenQ: why dustproof matters](https://benq.eu/en-eu/business/resource/trends/why-dustproof-is-vital-in-a-projector-world.html)

**Shadows and multiple projectors**
- [Sukthankar et al. 2001, dynamic shadow elimination](https://www.ri.cmu.edu/publications/dynamic-shadow-elimination-for-multi-projector-displays) · [Cham et al. 2003, occluder light suppression](https://mlanthology.org/cvpr/2003/cham2003cvpr-shadow) · [Summet et al., "Virtual Rear Projection: Do Shadows Matter?"](https://faculty.cc.gatech.edu/~summetj/papers/sp408-summet.pdf) · [Summet PhD thesis](https://repository.gatech.edu/entities/publication/1ce61bfe-85d9-4747-abfb-3b3285108253) · [Flagg et al., switched VRP](https://faculty.cc.gatech.edu/~summetj/papers/switchedvrp.pdf)

**Building it**
- [StarTech PROJWALLMNT](https://www.startech.com/en-us/display-video-products/projwallmnt) · [CDW price listing](https://www.cdw.com/product/startech-projector-wall-mount/5972549)
- Raspberry Pi 5: [screen configuration guide](https://thinkrobotics.com/es/blogs/learn/how-to-use-screen-configuration-on-raspberry-pi-5-a-step-by-step-guide) · [dual-HDMI boot issue](https://github.com/raspberrypi/linux/issues/7148) · [2026 price rises (Liliputing)](https://liliputing.com/?p=198888) · [Pi vs mini PC prices (Tom's Hardware)](https://www.tomshardware.com/raspberry-pi/raspberry-pi-and-mini-pc-home-lab-prices-hit-parity-as-dram-costs-skyrocket-price-hikes-force-hobbyists-to-weigh-up-performance-versus-power-consumption)
- PJLink in Python: [pypjlink](https://pypi.org/project/pypjlink/) · [pypjlink2](https://pypi.org/project/pypjlink2/1.2.2/) · [aiopjlink](https://pypi.org/project/aiopjlink/)
- [OpenCV structured light: GrayCodePattern](https://docs.opencv.org/4.x/d7/d9c/graycodepattern_8hpp.html)

**Mapping software**
- [MadMapper](https://madmapper.com/) · [HeavyM](https://heavym.net/) · [MadMapper vs HeavyM prices (Techjockey)](https://www.techjockey.com/us/compare/madmapper-vs-heavym) · [Resolume shop](https://resolume.com/shop) · [TouchDesigner licensing](https://derivative.ca/UserGuide/Licensing) · [ofxPiMapper](https://ofxpimapper.github.io) · [Pi mapping overview (Hackster)](https://www.hackster.io/news/what-you-need-to-know-about-projection-mapping-on-a-raspberry-pi-367f149593e1) · [Lightform sunset FAQ](https://guide.lightform.com/hc/en-us/articles/4417512435731-Sunset-FAQ)

**Gym systems and LEDs**
- [ValoClimb](https://valomotion.com/valoclimb) · [Valo Motion × Entre-Prises](https://blooloop.com/technology/news/valo-motion-partners-entre-prises/) · [KL Multimedia interactive wall](https://www.klmultimedia.com/Interactive-Climbing-Wall.html) · [Luxov](https://de.slideshare.net/witekio/luxov-connected-climbing-wall)
- [Kilter Board](https://kiltergrips.com/collections/kilter-board) · [Kilter Full Ride (Setter Closet)](https://settercloset.com/products/kilter-board-fullride-complete) · [PeggyBoard](https://github.com/PegorK/PeggyBoard) · [Boardsesh spray-wall LED editor](https://github.com/boardsesh/boardsesh/pull/7377)

**Safety**
- [FDA: laser light shows](https://www.fda.gov/radiation-emitting-products/home-business-and-entertainment-products/laser-light-shows) · [ILDA safety overview (PDF)](https://www.ilda.com/resources/Safety/Laser_Light_Show_Safety_Overview_One_Page-v7-ILDA-logo.pdf) · [lasershowsafety.info FAQ](https://lasershowsafety.info/faq.html) · [laserpointersafety.com: US agencies](https://laserpointersafety.com/rules-general/us-regulatory-agencies/us-regulatory-agencies.html) · [Epson projector laser safety notice](https://files.support.epson.com/docid/cpd6/cpd64112/source/notices/reference/ebpq2213b_2220b/laser_safety_info_ebpq2213b_2216w.html)

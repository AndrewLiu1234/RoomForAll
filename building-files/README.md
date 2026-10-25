# Repository 3D Building Files (`building-files/`)

This directory contains the canonical binary glTF 2.0 (`.glb`) 3D venue building models used for multi-level 3D seat parsing, Sight Target detection, first-person POV rendering, and Argon spatial review.

---

## 1. `building-files/smallClassroom.glb` (50-Seat Tiered University Lecture Classroom)

- **Source:** Exported from `smallClassroom.blend` (80 glTF nodes, 24 meshes, 1:1 metre scale, Y-up `+Y`, facing `-Z`).
- **3D Chair Objects (`50` physical chairs across `5` stepped tiers):**
  - Nodes `0..49`: `Chair_R1_S01` .. `Chair_R5_S10` (instancing `Ergonomic_Swivel_Task_Chair_MasterMesh` with `Mat_Chair_Upholstery`, `Mat_Chair_Frame`, `Mat_Chair_Armpad`).
  - **5 Stepped Riser Elevations (`Y`):**
    - Row 1 (`Chair_R1_S01..S10`): `y = 0.16 m`
    - Row 2 (`Chair_R2_S01..S10`): `y = 0.34 m`
    - Row 3 (`Chair_R3_S01..S10`): `y = 0.52 m`
    - Row 4 (`Chair_R4_S01..S10`): `y = 0.70 m`
    - Row 5 (`Chair_R5_S01..S10`): `y = 0.88 m`
- **Sight Target & Focal Wall Objects:**
  - `Screen_Projection_16x9` (Node `75`): Dropdown 16:9 projection screen (`Mat_Projection_Screen` active canvas centered at `[0.60, 2.94, -4.38]`, `width = 3.72 m`, `height = 2.04 m`, facing `+Z` `yaw = 180°`).
  - `Wall_Teaching_SlidingChalkboards` (Node `72`): Front sliding chalkboard/whiteboard assembly (`center = [0.80, 1.57, -4.48]`, `width = 5.26 m`, `height = 1.36 m`).
- **Movable Obstacles & Shell Objects:**
  - `Obs_Rolling_Whiteboard_Easel` (Node `64`), `Obs_Mobile_AV_Cart` (Node `63`), `Obs_Lecture_Capture_Tripod` (Node `62`), `Obs_Aisle_Backpacks_And_Bin` (Node `61`), `Lectern_Instructor_Podium` (Node `56`), `Desk_Tier_1..5` (Nodes `51..55`), `Exit_Door_1_Rear_West` (Node `58`), `Exit_Door_2_Front_East` (Node `59`).
  - Note for agents: `Wheelchair_Bay_1_Left` (Node `77`) and `Wheelchair_Bay_2_Right` (Node `78`) are flat (`0.02 m` tall) floor markings at `[-1.45, 0, -2.45]` and `[1.45, 0, -2.45]` without physical chairs; only the 50 physical 3D chair objects (`Chair_R1_S01..Chair_R5_S10`) should be treated as chairs.

---

## 2. `building-files/torium.glb` (Multi-Level Grand Auditorium)

- **Source:** Binary glTF 2.0 auditorium model (`1,645` glTF nodes, `88` meshes, 1:1 metre scale, Y-up `+Y`).
- **3D Chair Objects (`1,528` physical seats across Orchestra, Grand Tier, and Side Galleries):**
  - `Seat_Orch_*`: Lower Orchestra curved bowl (`y = 0.15 m .. 1.98 m`).
  - `Seat_GT01_*` .. `Seat_GT05_*`: Grand Tier balcony (`y = 1.45 m .. 3.05 m`).
  - `Seat_LowerGallery_*` & `Seat_UpperGallery_*`: Multi-level side gallery boxes (`y = 4.66 m .. 9.26 m`).
  - Note for agents: Node `31` (`Master_Auditorium_Seat`) is the unplaced master template mesh at origin and should be excluded when enumerating placed auditorium seats.
- **Stage & Focal Objects:**
  - `Stage_Apron_And_Riser`, `Proscenium_Arch_Wall`, `Upstage_Acoustic_Shell_Towers`, `Main_Velvet_Valance_Curtain`, `Stage_Left_Wing_Curtain`, `Stage_Right_Wing_Curtain`, `Overhead_Stage_Box_Truss_Grid`.

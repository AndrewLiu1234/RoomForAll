# Project & Engineering Rules

## 1. Mandatory Adversarial Critic Invocation
Whenever starting, planning, scaffolding, or implementing any new project, subsystem, or hackathon build in this workspace:
- The agent **MUST** activate the `adversarial-critic` skill.
- Before finalizing the project architecture, tech stack, or implementation, the agent **MUST** invoke an **Adversarial Critic** subagent (`invoke_subagent` with the `adversarial-critic` role) to stress-test the proposal.
- The agent must review the Critic's findings, remediate all critical flaws, and present the user with an Adversarial Audit summary showing what was challenged and how the project was hardened.

## 2. Design & Polish Standards
- When building animations, follow the `animate` skill (Emil Kowalski standards).
- When styling UI components, follow the `better-ui` skill (Jakub Krehel polish principles).
- When resolving user requirements or ambiguous architectures, use the `grill-me` skill to interview across design tree frontiers.

## 3. Repository 3D Building Assets (`building-files/`)
Agents working on 3D scene parsing, seat detection, sightline evaluation, or viewport rendering **MUST** note that the repository includes canonical 3D glTF 2.0 (`.glb`) building files in `./building-files/` (documented in `./building-files/README.md`):
- **`building-files/smallClassroom.glb`** (also served at `public/venue/smallClassroom.glb`):
  - **50 physical 3D chairs** (`Chair_R1_S01` .. `Chair_R5_S10`, instancing `Ergonomic_Swivel_Task_Chair_MasterMesh` with `Mat_Chair_Upholstery`) across **5 stepped riser elevations** (`y = 0.16 m, 0.34 m, 0.52 m, 0.70 m, 0.88 m`).
  - **Sight Target:** `Screen_Projection_16x9` (Node `75`, active `Mat_Projection_Screen` canvas at `[0.60, 2.94, -4.38]`, `3.72 m × 2.04 m`, facing `+Z`) and `Wall_Teaching_SlidingChalkboards` (Node `72`, `[0.80, 1.57, -4.48]`).
  - **Movable Obstacles & Shell:** `Obs_Rolling_Whiteboard_Easel`, `Obs_Mobile_AV_Cart`, `Obs_Lecture_Capture_Tripod`, `Obs_Aisle_Backpacks_And_Bin`, `Desk_Tier_1..5`, `Exit_Door_1_Rear_West`, `Exit_Door_2_Front_East`. (`Wheelchair_Bay_1_Left` and `Wheelchair_Bay_2_Right` are flat `0.02 m` floor markings without chairs.)
- **`building-files/torium.glb`**:
  - **1,528 physical 3D auditorium seats** (`Seat_Orch_*`, `Seat_GT01..05_*`, `Seat_LowerGallery_*`, `Seat_UpperGallery_*`) across Orchestra, Grand Tier, and Side Galleries (`y = 0.15 m .. 9.26 m`), plus `Stage_Apron_And_Riser`, `Proscenium_Arch_Wall`, and `Upstage_Acoustic_Shell_Towers`.



/** Starter games for the Game Engine editor: an empty project, a 3D playground and a 2D platformer. */
import { emptyGame, type Game, type GameNode } from './game.ts';

export type TemplateKind = 'empty' | '3d' | '2d';

const PLAYER_3D = `// A third-person character. Move with WASD / arrow keys, jump with Space.
export default class Player extends CharacterBody3D {
  // Exported variables show up in the Inspector and can be set per node.
  static exports = { speed: 5.0, jumpSpeed: 7.0 };
  speed = 5.0;
  jumpSpeed = 7.0;

  physicsProcess(delta: number) {
    const dir = Input.getVector('move_left', 'move_right', 'move_forward', 'move_back');
    this.velocity.x = dir.x * this.speed;
    this.velocity.z = dir.y * this.speed;

    if (!this.isOnFloor()) this.velocity.y -= 9.8 * delta;
    else if (Input.isActionJustPressed('jump')) this.velocity.y = this.jumpSpeed;

    this.moveAndSlide();
    if (dir.lengthSq() > 0) this.rotation.y = Math.atan2(-dir.x, -dir.y); // face where we walk
  }
}
`;

const PLAYER_2D = `// A platformer character with coyote time, jump buffering and variable jump height.
export default class Player2D extends CharacterBody2D {
  static exports = { speed: 240, jumpSpeed: 560, coyoteTime: 0.1, jumpBuffer: 0.1 };
  speed = 240;
  jumpSpeed = 560;
  coyoteTime = 0.1;
  jumpBuffer = 0.1;
  private coyote = 0;
  private buffer = 0;

  physicsProcess(delta: number) {
    const dir = Input.getAxis('move_left', 'move_right');
    this.velocity.x = moveToward(this.velocity.x, dir * this.speed, this.speed * 8 * delta);

    this.coyote = this.isOnFloor() ? this.coyoteTime : this.coyote - delta;
    this.buffer = Input.isActionJustPressed('jump') ? this.jumpBuffer : this.buffer - delta;

    // +Y is up in 2D, so gravity is negative; fall faster than we rise.
    if (!this.isOnFloor()) this.velocity.y -= 1400 * delta * (this.velocity.y < 0 ? 1.4 : 1);
    if (this.buffer > 0 && this.coyote > 0) { this.velocity.y = this.jumpSpeed; this.buffer = 0; this.coyote = 0; }
    if (Input.isActionJustReleased('jump') && this.velocity.y > 0) this.velocity.y *= 0.5; // short hop

    this.moveAndSlide();
    if (this.position.y < -700) { this.position.set(-300, 0); this.velocity.set(0, 0); } // fell off the world
  }
}
`;

const COIN = `// A coin: when the player touches it the score goes up and the coin disappears.
export default class Coin extends Area2D {
  ready() {
    this.connect('bodyEntered', (body: Node) => {
      if (!body.isInGroup('player')) return;
      this.getTree().callGroup('hud', 'addScore', 1);
      this.queueFree();
    });
  }
}
`;

const HUD = `// The score label. Other nodes find it through the "hud" group.
export default class Hud extends Label {
  score = 0;
  ready() {
    this.addToGroup('hud');
    this.text = 'Score: 0';
  }
  addScore(points: number) {
    this.score += points;
    this.text = 'Score: ' + this.score;
  }
}
`;

const mesh = (name: string, kind: string, size: number[], color: string, extra: Record<string, unknown> = {}, material: Record<string, unknown> = {}): GameNode => ({ name, type: 'MeshInstance3D', props: { mesh: kind, size, material: { color, roughness: 0.7, ...material }, ...extra } });
const shape3 = (kind: string, size: number[]): GameNode => ({ name: 'Shape', type: 'CollisionShape3D', props: { shape: kind, size } });
const sprite = (name: string, size: number[], color: string, shape = 'rect', extra: Record<string, unknown> = {}): GameNode => ({ name, type: 'Sprite2D', props: { shape, size, color, ...extra } });
const shape2 = (kind: string, size: number[]): GameNode => ({ name: 'Shape', type: 'CollisionShape2D', props: { shape: kind, size } });

export function templateGame(kind: TemplateKind, title = 'Untitled'): Game {
  const game = emptyGame(title);
  if (kind === 'empty') return game;
  if (kind === '3d') {
    game.scripts['scripts/player.ts'] = { code: PLAYER_3D };
    game.settings.background = '#87a8c9';
    game.scenes.main = {
      name: 'main', connections: [],
      root: {
        name: 'Main', type: 'Node3D', children: [
          { name: 'Environment', type: 'WorldEnvironment', props: { background: '#87a8c9', ambient: 0.55 } },
          { name: 'Sun', type: 'DirectionalLight3D', props: { position: [0, 8, 0], rotation: [-55, 35, 0], energy: 3 } },
          { name: 'Ground', type: 'StaticBody3D', props: { position: [0, -0.5, 0] }, children: [mesh('Mesh', 'box', [40, 1, 40], '#6f9a5b'), shape3('box', [40, 1, 40])] },
          { name: 'Wall', type: 'StaticBody3D', props: { position: [4, 1, -6] }, children: [mesh('Mesh', 'box', [6, 2, 1], '#9aa3ad'), shape3('box', [6, 2, 1])] },
          {
            name: 'Player', type: 'CharacterBody3D', script: 'scripts/player.ts', groups: ['player'], props: { position: [0, 1, 4] }, children: [
              mesh('Mesh', 'capsule', [0.8, 1.8, 0.8], '#e07a3f'), shape3('capsule', [0.8, 1.8, 0.8]),
              { name: 'Camera', type: 'Camera3D', props: { position: [0, 3, 6], rotation: [-18, 0, 0], current: true } },
            ],
          },
          { name: 'Crate1', type: 'RigidBody3D', props: { position: [2, 2, 0], bounce: 0.1 }, groups: ['crate'], children: [mesh('Mesh', 'box', [1, 1, 1], '#b9803f'), shape3('box', [1, 1, 1])] },
          { name: 'Crate2', type: 'RigidBody3D', props: { position: [2.3, 4, 0.2], bounce: 0.1 }, groups: ['crate'], children: [mesh('Mesh', 'box', [1, 1, 1], '#b9803f'), shape3('box', [1, 1, 1])] },
          { name: 'Ball', type: 'RigidBody3D', props: { position: [-3, 5, 0], bounce: 0.7 }, children: [mesh('Mesh', 'sphere', [1, 1, 1], '#c0392b', {}, { metalness: 0.2, roughness: 0.35 }), shape3('sphere', [1, 1, 1])] },
          { name: 'Hud', type: 'CanvasLayer', children: [{ name: 'Hint', type: 'Label', props: { text: 'WASD / arrows: move   Space: jump', position: [16, 12], size: [500, 30], fontSize: 18 } }] },
        ],
      },
    };
    return game;
  }
  game.scripts['scripts/player2d.ts'] = { code: PLAYER_2D };
  game.scripts['scripts/coin.ts'] = { code: COIN };
  game.scripts['scripts/hud.ts'] = { code: HUD };
  game.settings.background = '#1d2b3a';
  const coin = (name: string, x: number, y: number): GameNode => ({ name, type: 'Area2D', script: 'scripts/coin.ts', props: { position: [x, y] }, children: [sprite('Body', [20, 20], '#ffd166', 'circle'), shape2('circle', [20, 20])] });
  game.scenes.main = {
    name: 'main', connections: [],
    root: {
      name: 'Main', type: 'Node2D', children: [
        { name: 'Camera', type: 'Camera2D', props: { position: [0, 80], zoom: 1 } },
        { name: 'Ground', type: 'StaticBody2D', props: { position: [0, -220] }, children: [sprite('Body', [1400, 40], '#4a7c3a'), shape2('rect', [1400, 40])] },
        { name: 'Platform1', type: 'StaticBody2D', props: { position: [220, -90] }, children: [sprite('Body', [200, 20], '#6b8f4e'), shape2('rect', [200, 20])] },
        { name: 'Platform2', type: 'StaticBody2D', props: { position: [-120, 10] }, children: [sprite('Body', [180, 20], '#6b8f4e'), shape2('rect', [180, 20])] },
        { name: 'Player', type: 'CharacterBody2D', script: 'scripts/player2d.ts', groups: ['player'], props: { position: [-300, -150] }, children: [sprite('Body', [32, 48], '#e07a3f'), shape2('rect', [32, 48])] },
        coin('Coin1', 220, -40), coin('Coin2', -120, 60), coin('Coin3', 20, -150),
        { name: 'Hud', type: 'CanvasLayer', children: [{ name: 'Score', type: 'Label', script: 'scripts/hud.ts', props: { text: 'Score: 0', position: [16, 12], size: [300, 30], fontSize: 22 } }] },
      ],
    },
  };
  game.settings.gravity2d = 980;
  return game;
}

/** The scripting API of the Game Engine as a TypeScript declaration file: it gives the script editor completions and is
 * the reference the agent's skill points to. Keep it in step with engineRuntime.js. */
export const GAME_API_DTS = `
declare type Signalable = (...args: any[]) => void;
declare class Vector2 { x: number; y: number; constructor(x?: number, y?: number); set(x: number, y: number): this; copy(v: Vector2): this; clone(): Vector2; add(v: Vector2): this; sub(v: Vector2): this; multiplyScalar(s: number): this; length(): number; lengthSq(): number; normalize(): this; dot(v: Vector2): number; distanceTo(v: Vector2): number; lerp(v: Vector2, t: number): this; }
declare class Vector3 { x: number; y: number; z: number; constructor(x?: number, y?: number, z?: number); set(x: number, y: number, z: number): this; copy(v: Vector3): this; clone(): Vector3; add(v: Vector3): this; sub(v: Vector3): this; addScaledVector(v: Vector3, s: number): this; multiplyScalar(s: number): this; length(): number; lengthSq(): number; normalize(): this; dot(v: Vector3): number; cross(v: Vector3): this; distanceTo(v: Vector3): number; lerp(v: Vector3, t: number): this; }
declare class Color { r: number; g: number; b: number; constructor(hex?: string | number); set(hex: string | number): this; lerp(c: Color, t: number): this; getHexString(): string; }
declare class Euler { x: number; y: number; z: number; set(x: number, y: number, z: number): this; }
declare class Quaternion { x: number; y: number; z: number; w: number; }
declare class Matrix4 {}
declare const MathUtils: { clamp(v: number, a: number, b: number): number; lerp(a: number, b: number, t: number): number; degToRad(d: number): number; radToDeg(r: number): number; randFloat(a: number, b: number): number; smoothstep(x: number, a: number, b: number): number };

/** The base of every node: a tree item with a name, children, groups, signals and a script. Override ready(), process(), physicsProcess(), input(). */
declare class Node {
  name: string; parent: Node | null; children: Node[]; readonly type: string;
  ready?(): void; enterTree?(): void; exitTree?(): void;
  process?(delta: number): void; physicsProcess?(delta: number): void; input?(event: any): void; unhandledInput?(event: any): void;
  constructor(name?: string);
  addChild<T extends Node>(child: T, options?: { name?: string }): T; removeChild(child: Node): void; getChildren(): Node[]; getChild(index: number): Node | null; getChildCount(): number;
  findChild(name: string, recursive?: boolean): Node | null; getNode<T extends Node = Node>(path: string): T; getNodeOrNull<T extends Node = Node>(path: string): T | null; getParent(): Node | null; getPath(): string; getTree(): SceneTree;
  addToGroup(group: string): void; removeFromGroup(group: string): void; isInGroup(group: string): boolean; isInsideTree(): boolean;
  connect(signal: string, callable: Signalable): this; disconnect(signal: string, callable?: Signalable): void; emitSignal(signal: string, ...args: any[]): void;
  queueFree(): void; reparent(newParent: Node): void; duplicate(): this; createTween(): Tween; walk(): Generator<Node>;
  /** Set a property the way the editor does (position as [x,y,z], rotation in degrees, material patches …). */
  setProp(key: string, value: any): void;
}
declare class Node3D extends Node {
  position: Vector3; rotation: Vector3 & { x: number; y: number; z: number }; scale: Vector3; rotationDegrees: Vector3; visible: boolean; globalPosition: Vector3;
  forward(): Vector3; right(): Vector3; up(): Vector3; translate(v: Vector3): void; rotateX(a: number): void; rotateY(a: number): void; rotateZ(a: number): void; lookAt(target: Vector3): void;
}
declare class Marker3D extends Node3D {}
declare class MeshInstance3D extends Node3D { mesh: 'box' | 'sphere' | 'cylinder' | 'cone' | 'capsule' | 'torus' | 'plane'; size: Vector3; material: { color: string; metalness: number; roughness: number; emissive: string; emissiveIntensity: number; opacity: number }; setColor(hex: string): void; }
declare class Camera3D extends Node3D { fov: number; current: boolean; makeCurrent(): void; project(world: Vector3): Vector2; }
declare class DirectionalLight3D extends Node3D { color: string; energy: number; shadow: boolean; }
declare class OmniLight3D extends Node3D { color: string; energy: number; range: number; }
declare class SpotLight3D extends Node3D { color: string; energy: number; range: number; spotAngle: number; }
declare class WorldEnvironment extends Node { background: string; ambient: number; fog: boolean; }
declare class CollisionShape3D extends Node3D { shape: 'box' | 'sphere' | 'capsule'; size: Vector3; disabled: boolean; }
declare class PhysicsBody3D extends Node3D { collisionLayer: number; collisionMask: number; }
declare class StaticBody3D extends PhysicsBody3D {}
declare class RigidBody3D extends PhysicsBody3D { mass: number; gravityScale: number; bounce: number; friction: number; linearDamp: number; linearVelocity: Vector3; applyImpulse(v: Vector3): void; }
/** Move it in physicsProcess: set velocity, then call moveAndSlide(). Floor, wall and ceiling flags are updated by moveAndSlide(). */
declare class CharacterBody3D extends PhysicsBody3D { velocity: Vector3; floorMaxAngle: number; isOnFloor(): boolean; isOnWall(): boolean; isOnCeiling(): boolean; getFloorNormal(): Vector3; getSlideCollisionCount(): number; getSlideCollision(i: number): { collider: Node; normal: Vector3 } | null; getGravity(): Vector3; moveAndSlide(): boolean; moveAndCollide(motion: Vector3): { collider: Node; normal: Vector3 } | null; }
/** Signals: bodyEntered(body), bodyExited(body). */
declare class Area3D extends PhysicsBody3D { monitoring: boolean; getOverlappingBodies(): Node[]; hasOverlappingBodies(): boolean; overlapsBody(b: Node): boolean; }

declare class Node2D extends Node { position: Vector2; rotation: number; rotationDegrees: number; scale: Vector2; visible: boolean; zIndex: number; globalPosition: Vector2; translate(v: Vector2): void; lookAt(p: Vector2): void; }
declare class Marker2D extends Node2D {}
declare class Sprite2D extends Node2D { shape: 'rect' | 'circle' | 'triangle'; size: Vector2; color: string; texture: string | null; }
declare class Camera2D extends Node2D { zoom: number; current: boolean; makeCurrent(): void; }
declare class CollisionShape2D extends Node2D { shape: 'rect' | 'circle'; size: Vector2; disabled: boolean; }
declare class PhysicsBody2D extends Node2D { collisionLayer: number; collisionMask: number; }
declare class StaticBody2D extends PhysicsBody2D {}
declare class RigidBody2D extends PhysicsBody2D { mass: number; gravityScale: number; bounce: number; friction: number; linearDamp: number; linearVelocity: Vector2; applyImpulse(v: Vector2): void; }
declare class CharacterBody2D extends PhysicsBody2D { velocity: Vector2; floorMaxAngle: number; isOnFloor(): boolean; isOnWall(): boolean; isOnCeiling(): boolean; getFloorNormal(): Vector3; getSlideCollisionCount(): number; getSlideCollision(i: number): { collider: Node; normal: Vector3 } | null; getGravity(): Vector2; moveAndSlide(): boolean; moveAndCollide(motion: Vector2): { collider: Node; normal: Vector3 } | null; }
declare class Area2D extends PhysicsBody2D { monitoring: boolean; getOverlappingBodies(): Node[]; hasOverlappingBodies(): boolean; overlapsBody(b: Node): boolean; }

declare class CanvasLayer extends Node { layer: number; }
declare class Control extends Node { position: Vector2; size: Vector2; anchor: string; visible: boolean; color: string; text: string; fontSize: number; align: string; }
declare class Label extends Control {}
declare class ColorRect extends Control {}
/** Signal: pressed. */
declare class Button extends Control {}
declare class ProgressBar extends Control { value: number; maxValue: number; }
/** Signal: timeout. */
declare class Timer extends Node { waitTime: number; oneShot: boolean; autostart: boolean; timeLeft: number; start(time?: number): void; stop(): void; isStopped(): boolean; }
/** Signal: animationFinished(name). Animations are defined in the scene (see the "animation" operation). */
declare class AnimationPlayer extends Node { animations: Record<string, any>; autoplay: string; speedScale: number; currentAnimation: string; play(name: string, fromTime?: number): void; stop(): void; pause(): void; seek(t: number): void; isPlaying(): boolean; hasAnimation(name: string): boolean; getAnimationList(): string[]; }

declare class Tween {
  setTrans(t: 'linear' | 'sine' | 'quad' | 'cubic' | 'quart' | 'expo' | 'circ' | 'back' | 'elastic' | 'bounce'): this; setEase(e: 'in' | 'out' | 'inout'): this; setParallel(p?: boolean): this; setLoops(n: number): this;
  tweenProperty(target: any, property: string, to: any, duration: number): { setTrans(t: string): any; setEase(e: string): any; setDelay(s: number): any };
  tweenCallback(fn: () => void): this; tweenInterval(seconds: number): this; chain(): this; kill(): void; onFinished(fn: () => void): this;
}

declare class SceneTree {
  root: Node; paused: boolean; timeScale: number; currentScene: Node | null;
  getNodesInGroup(group: string): Node[]; getFirstNodeInGroup(group: string): Node | null; callGroup(group: string, method: string, ...args: any[]): void;
  changeScene(name: string): void; reloadCurrentScene(): void; quit(): void;
  /** Await it: await this.getTree().createTimer(1.5); */
  createTimer(seconds: number): Node & PromiseLike<void>;
}

declare const Input: {
  isActionPressed(action: string): boolean; isActionJustPressed(action: string): boolean; isActionJustReleased(action: string): boolean; getActionStrength(action: string): number;
  getAxis(negative: string, positive: string): number; getVector(negX: string, posX: string, negY: string, posY: string): Vector2;
  isKeyPressed(code: string): boolean; getMousePosition(): Vector2; isMouseButtonPressed(button: number): boolean;
};
declare const Physics: { raycast(origin: Vector3, direction: Vector3, maxDistance?: number, options?: { mask?: number; exclude?: Node | Node[] }): { collider: Node; position: Vector3; normal: Vector3; distance: number } | null };
declare const Engine: { timeScale: number; readonly time: number; readonly frame: number; readonly gravity3d: number; readonly gravity2d: number; size(): { w: number; h: number } };
declare function print(...args: any[]): void;
declare function printErr(...args: any[]): void;
declare function instantiate(sceneName: string): Node;
declare function preload(sceneName: string): { instantiate(): Node };
declare function lerp(a: number, b: number, t: number): number;
declare function clamp(v: number, min: number, max: number): number;
declare function sign(v: number): number;
declare function smoothstep(x: number, a: number, b: number): number;
declare function moveToward(from: number, to: number, delta: number): number;
declare function wrap(v: number, min: number, max: number): number;
declare function deg2rad(d: number): number;
declare function rad2deg(r: number): number;
declare function randf(): number;
declare function randi(): number;
declare function randfRange(min: number, max: number): number;
declare function randiRange(min: number, max: number): number;
declare function ease(t: number, trans?: string, mode?: 'in' | 'out' | 'inout'): number;
declare function getTree(): SceneTree;
declare function getNode<T extends Node = Node>(path: string): T;
`;

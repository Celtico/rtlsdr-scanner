import * as THREE from 'three';

/** Removes every child of a group and frees its geometry, materials and textures. */
export function disposeGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    const obj = child as THREE.Mesh | THREE.Line | THREE.Sprite;
    obj.geometry?.dispose();
    const mat = obj.material as THREE.Material | THREE.Material[] | undefined;
    for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      (m as THREE.SpriteMaterial).map?.dispose();
      m.dispose();
    }
  }
}

/**
 * A text label that always faces the camera and keeps the same size on screen however far it is, so
 * near labels do not balloon and far ones stay readable.
 */
export function label(text: string, color: string, scale = 1): THREE.Sprite {
  const pad = 8;
  const font = '600 28px system-ui, sans-serif';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.height = 44;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false }));
  sprite.renderOrder = 10; // text is always drawn on top of the scene
  // Without size attenuation the scale is a fraction of the view, not scene units.
  const h = 0.036 * scale;
  sprite.scale.set((canvas.width / canvas.height) * h, h, 1);
  return sprite;
}

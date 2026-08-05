'use client';

import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useEffect } from 'react';

type SceneNode = {
  archetype: string;
  entityLogicalKey: string;
  layer: string;
  materialToken: string;
  provenance: { sourceStableKey: string };
  transform: { xMilli: number; yMilli: number; zMilli: number; yawMilliDegrees: number };
};

function colorFor(node: SceneNode): string {
  if (node.layer === 'spawn') return '#2f6f4e';
  if (node.archetype.includes('council')) return '#3d4f6f';
  if (node.archetype.includes('workshop') || node.archetype.includes('harbor')) return '#8a5a2b';
  if (node.archetype.includes('market')) return '#6b4f8a';
  if (node.layer === 'district') return '#9aa4b2';
  return '#6d7278';
}

function SceneNodeMesh({
  node,
  selected,
  onSelect,
}: {
  node: SceneNode;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const x = node.transform.xMilli / 1000;
  const z = node.transform.yMilli / 1000;
  const y = node.transform.zMilli / 1000 + (node.layer === 'building' ? 1.5 : 0.2);
  const height = node.layer === 'building' ? 3 : node.layer === 'spawn' ? 0.4 : 0.2;
  const size = node.layer === 'district' ? 8 : node.layer === 'building' ? 2.2 : 1;
  return (
    <mesh
      position={[x, y, z]}
      rotation={[0, (node.transform.yawMilliDegrees / 1000) * (Math.PI / 180), 0]}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.provenance.sourceStableKey);
      }}
    >
      <boxGeometry args={[size, height, size]} />
      <meshStandardMaterial color={selected ? '#c45c26' : colorFor(node)} />
    </mesh>
  );
}

export function ExploreCanvas({
  nodes,
  selectedKey,
  onSelect,
  onContextLost,
}: {
  nodes: SceneNode[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onContextLost: () => void;
}) {
  useEffect(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    const handleLost = (event: Event) => {
      event.preventDefault();
      onContextLost();
    };
    canvas.addEventListener('webglcontextlost', handleLost);
    return () => canvas.removeEventListener('webglcontextlost', handleLost);
  }, [onContextLost]);

  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return (
    <div className="explore-canvas" role="img" aria-label="Low-poly city WebGL projection">
      <Canvas camera={{ position: [40, 35, 40], fov: 45 }} dpr={[1, 1.5]}>
        <color attach="background" args={['#dfe6ee']} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[20, 40, 10]} intensity={0.9} />
        {nodes.map((node) => (
          <SceneNodeMesh
            key={node.provenance.sourceStableKey}
            node={node}
            selected={selectedKey === node.provenance.sourceStableKey}
            onSelect={onSelect}
          />
        ))}
        <OrbitControls enableDamping={!reducedMotion} enablePan makeDefault />
      </Canvas>
    </div>
  );
}

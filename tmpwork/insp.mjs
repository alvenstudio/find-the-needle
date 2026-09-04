import { NodeIO } from '@gltf-transform/core';
import { KHRMeshQuantization } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions([KHRMeshQuantization]);
for (const f of ['straw','grass_tuft','hay_wisp']) {
  const doc = await io.read(`public/models/${f}.glb`);
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives())
      console.log(f, mesh.getName(), 'verts', prim.getAttribute('POSITION').getCount(), 'tris', prim.getIndices() ? prim.getIndices().getCount()/3 : '-', prim.listSemantics().join(','));
}

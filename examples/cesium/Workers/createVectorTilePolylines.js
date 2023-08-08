/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.99
 *
 * Copyright 2011-2022 Cesium Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Columbus View (Pat. Pend.)
 *
 * Portions licensed separately.
 * See https://github.com/CesiumGS/cesium/blob/main/LICENSE.md for full licensing details.
 */

define(['./Matrix3-f22b0303', './combine-4598d225', './AttributeCompression-e9888cb8', './Math-9be8b918', './IndexDatatype-b4e5cf89', './Matrix2-036c77dd', './createTaskProcessorWorker', './Check-d10e5f2e', './defaultValue-0ab18f7d', './ComponentDatatype-13a5630b', './WebGLConstants-f27a5e29', './RuntimeError-e5c6a8b9'], (function (Matrix3, combine, AttributeCompression, Math, IndexDatatype, Matrix2, createTaskProcessorWorker, Check, defaultValue, ComponentDatatype, WebGLConstants, RuntimeError) { 'use strict';

  const maxShort = 32767;

  const scratchBVCartographic = new Matrix3.Cartographic();
  const scratchEncodedPosition = new Matrix3.Cartesian3();

  function decodeVectorPolylinePositions(
    positions,
    rectangle,
    minimumHeight,
    maximumHeight,
    ellipsoid
  ) {
    const positionsLength = positions.length / 3;
    const uBuffer = positions.subarray(0, positionsLength);
    const vBuffer = positions.subarray(positionsLength, 2 * positionsLength);
    const heightBuffer = positions.subarray(
      2 * positionsLength,
      3 * positionsLength
    );
    AttributeCompression.AttributeCompression.zigZagDeltaDecode(uBuffer, vBuffer, heightBuffer);

    const decoded = new Float64Array(positions.length);
    for (let i = 0; i < positionsLength; ++i) {
      const u = uBuffer[i];
      const v = vBuffer[i];
      const h = heightBuffer[i];

      const lon = Math.CesiumMath.lerp(rectangle.west, rectangle.east, u / maxShort);
      const lat = Math.CesiumMath.lerp(rectangle.south, rectangle.north, v / maxShort);
      const alt = Math.CesiumMath.lerp(minimumHeight, maximumHeight, h / maxShort);

      const cartographic = Matrix3.Cartographic.fromRadians(
        lon,
        lat,
        alt,
        scratchBVCartographic
      );
      const decodedPosition = ellipsoid.cartographicToCartesian(
        cartographic,
        scratchEncodedPosition
      );
      Matrix3.Cartesian3.pack(decodedPosition, decoded, i * 3);
    }
    return decoded;
  }

  const scratchRectangle = new Matrix2.Rectangle();
  const scratchEllipsoid = new Matrix3.Ellipsoid();
  const scratchCenter = new Matrix3.Cartesian3();
  const scratchMinMaxHeights = {
    min: undefined,
    max: undefined,
  };

  function unpackBuffer(packedBuffer) {
    packedBuffer = new Float64Array(packedBuffer);

    let offset = 0;
    scratchMinMaxHeights.min = packedBuffer[offset++];
    scratchMinMaxHeights.max = packedBuffer[offset++];

    Matrix2.Rectangle.unpack(packedBuffer, offset, scratchRectangle);
    offset += Matrix2.Rectangle.packedLength;

    Matrix3.Ellipsoid.unpack(packedBuffer, offset, scratchEllipsoid);
    offset += Matrix3.Ellipsoid.packedLength;

    Matrix3.Cartesian3.unpack(packedBuffer, offset, scratchCenter);
  }

  function getPositionOffsets(counts) {
    const countsLength = counts.length;
    const positionOffsets = new Uint32Array(countsLength + 1);
    let offset = 0;
    for (let i = 0; i < countsLength; ++i) {
      positionOffsets[i] = offset;
      offset += counts[i];
    }
    positionOffsets[countsLength] = offset;
    return positionOffsets;
  }

  const scratchP0 = new Matrix3.Cartesian3();
  const scratchP1 = new Matrix3.Cartesian3();
  const scratchPrev = new Matrix3.Cartesian3();
  const scratchCur = new Matrix3.Cartesian3();
  const scratchNext = new Matrix3.Cartesian3();

  function createVectorTilePolylines(parameters, transferableObjects) {
    const encodedPositions = new Uint16Array(parameters.positions);
    const widths = new Uint16Array(parameters.widths);
    const counts = new Uint32Array(parameters.counts);
    const batchIds = new Uint16Array(parameters.batchIds);

    unpackBuffer(parameters.packedBuffer);
    const rectangle = scratchRectangle;
    const ellipsoid = scratchEllipsoid;
    const center = scratchCenter;
    const minimumHeight = scratchMinMaxHeights.min;
    const maximumHeight = scratchMinMaxHeights.max;

    const positions = decodeVectorPolylinePositions(
      encodedPositions,
      rectangle,
      minimumHeight,
      maximumHeight,
      ellipsoid
    );

    const positionsLength = positions.length / 3;
    const size = positionsLength * 4 - 4;

    const curPositions = new Float32Array(size * 3);
    const prevPositions = new Float32Array(size * 3);
    const nextPositions = new Float32Array(size * 3);
    const expandAndWidth = new Float32Array(size * 2);
    const vertexBatchIds = new Uint16Array(size);

    let positionIndex = 0;
    let expandAndWidthIndex = 0;
    let batchIdIndex = 0;

    let i;
    let offset = 0;
    let length = counts.length;

    for (i = 0; i < length; ++i) {
      const count = counts[i];
      const width = widths[i];
      const batchId = batchIds[i];

      for (let j = 0; j < count; ++j) {
        let previous;
        if (j === 0) {
          const p0 = Matrix3.Cartesian3.unpack(positions, offset * 3, scratchP0);
          const p1 = Matrix3.Cartesian3.unpack(positions, (offset + 1) * 3, scratchP1);

          previous = Matrix3.Cartesian3.subtract(p0, p1, scratchPrev);
          Matrix3.Cartesian3.add(p0, previous, previous);
        } else {
          previous = Matrix3.Cartesian3.unpack(
            positions,
            (offset + j - 1) * 3,
            scratchPrev
          );
        }

        const current = Matrix3.Cartesian3.unpack(
          positions,
          (offset + j) * 3,
          scratchCur
        );

        let next;
        if (j === count - 1) {
          const p2 = Matrix3.Cartesian3.unpack(
            positions,
            (offset + count - 1) * 3,
            scratchP0
          );
          const p3 = Matrix3.Cartesian3.unpack(
            positions,
            (offset + count - 2) * 3,
            scratchP1
          );

          next = Matrix3.Cartesian3.subtract(p2, p3, scratchNext);
          Matrix3.Cartesian3.add(p2, next, next);
        } else {
          next = Matrix3.Cartesian3.unpack(positions, (offset + j + 1) * 3, scratchNext);
        }

        Matrix3.Cartesian3.subtract(previous, center, previous);
        Matrix3.Cartesian3.subtract(current, center, current);
        Matrix3.Cartesian3.subtract(next, center, next);

        const startK = j === 0 ? 2 : 0;
        const endK = j === count - 1 ? 2 : 4;

        for (let k = startK; k < endK; ++k) {
          Matrix3.Cartesian3.pack(current, curPositions, positionIndex);
          Matrix3.Cartesian3.pack(previous, prevPositions, positionIndex);
          Matrix3.Cartesian3.pack(next, nextPositions, positionIndex);
          positionIndex += 3;

          const direction = k - 2 < 0 ? -1.0 : 1.0;
          expandAndWidth[expandAndWidthIndex++] = 2 * (k % 2) - 1;
          expandAndWidth[expandAndWidthIndex++] = direction * width;

          vertexBatchIds[batchIdIndex++] = batchId;
        }
      }

      offset += count;
    }

    const indices = IndexDatatype.IndexDatatype.createTypedArray(size, positionsLength * 6 - 6);
    let index = 0;
    let indicesIndex = 0;
    length = positionsLength - 1;
    for (i = 0; i < length; ++i) {
      indices[indicesIndex++] = index;
      indices[indicesIndex++] = index + 2;
      indices[indicesIndex++] = index + 1;

      indices[indicesIndex++] = index + 1;
      indices[indicesIndex++] = index + 2;
      indices[indicesIndex++] = index + 3;

      index += 4;
    }

    transferableObjects.push(
      curPositions.buffer,
      prevPositions.buffer,
      nextPositions.buffer
    );
    transferableObjects.push(
      expandAndWidth.buffer,
      vertexBatchIds.buffer,
      indices.buffer
    );

    let results = {
      indexDatatype:
        indices.BYTES_PER_ELEMENT === 2
          ? IndexDatatype.IndexDatatype.UNSIGNED_SHORT
          : IndexDatatype.IndexDatatype.UNSIGNED_INT,
      currentPositions: curPositions.buffer,
      previousPositions: prevPositions.buffer,
      nextPositions: nextPositions.buffer,
      expandAndWidth: expandAndWidth.buffer,
      batchIds: vertexBatchIds.buffer,
      indices: indices.buffer,
    };

    if (parameters.keepDecodedPositions) {
      const positionOffsets = getPositionOffsets(counts);
      transferableObjects.push(positions.buffer, positionOffsets.buffer);
      results = combine.combine(results, {
        decodedPositions: positions.buffer,
        decodedPositionOffsets: positionOffsets.buffer,
      });
    }

    return results;
  }
  var createVectorTilePolylines$1 = createTaskProcessorWorker(createVectorTilePolylines);

  return createVectorTilePolylines$1;

}));
//# sourceMappingURL=createVectorTilePolylines.js.map

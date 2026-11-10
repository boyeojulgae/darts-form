"""Build MediaPipe Tasks pose bundles from the tflite files shipped in the @mediapipe/pose npm package.

The Tasks runtime needs image-normalisation metadata on each model, which the plain tflite files lack,
so this writes that metadata and zips the two models into a .task bundle.
"""
import os
import sys
import zipfile

import flatbuffers
import numpy as np
from mediapipe.tasks.metadata import metadata_schema_py_generated as mfb
from mediapipe.tasks.metadata import schema_py_generated as sfb

SRC = sys.argv[1]
OUT = sys.argv[2]


def metadata_bytes(name, mean, std, n_out):
    model = mfb.ModelMetadataT()
    model.name = name
    inp = mfb.TensorMetadataT()
    inp.name = "image"
    inp.content = mfb.ContentT()
    inp.content.contentProperties = mfb.ImagePropertiesT()
    inp.content.contentProperties.colorSpace = mfb.ColorSpaceType.RGB
    inp.content.contentPropertiesType = mfb.ContentProperties.ImageProperties
    unit = mfb.ProcessUnitT()
    unit.optionsType = mfb.ProcessUnitOptions.NormalizationOptions
    unit.options = mfb.NormalizationOptionsT()
    unit.options.mean = [mean]
    unit.options.std = [std]
    inp.processUnits = [unit]
    sub = mfb.SubGraphMetadataT()
    sub.inputTensorMetadata = [inp]
    outs = []
    for i in range(n_out):
        t = mfb.TensorMetadataT()
        t.name = f"output_{i}"
        outs.append(t)
    sub.outputTensorMetadata = outs
    model.subgraphMetadata = [sub]
    b = flatbuffers.Builder(0)
    b.Finish(model.Pack(b), b"M001")
    return bytes(b.Output())


def with_metadata(path, name, mean, std):
    buf = open(path, "rb").read()
    root = sfb.Model.GetRootAsModel(buf, 0)
    model = sfb.ModelT.InitFromObj(root)
    n_out = len(model.subgraphs[0].outputs)
    meta = metadata_bytes(name, mean, std, n_out)
    nb = sfb.BufferT()
    nb.data = np.frombuffer(meta, dtype=np.uint8)
    model.buffers.append(nb)
    entry = sfb.MetadataT()
    entry.name = "TFLITE_METADATA"
    entry.buffer = len(model.buffers) - 1
    model.metadata = list(model.metadata or []) + [entry]
    b = flatbuffers.Builder(len(buf) + 4096)
    b.Finish(model.Pack(b), b"TFL3")
    out = bytes(b.Output())
    print(os.path.basename(path), "inputs", len(model.subgraphs[0].inputs), "outputs", n_out, "size", len(buf), "->", len(out))
    return out


detector = with_metadata(os.path.join(SRC, "pose_solution_packed_assets.data"), "pose_detector", 127.5, 127.5)
for kind in ("lite", "full"):
    landmarks = with_metadata(os.path.join(SRC, f"pose_landmark_{kind}.tflite"), "pose_landmarks_detector", 0.0, 255.0)
    out = os.path.join(OUT, f"pose_landmarker_{kind}.task")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
        z.writestr(zipfile.ZipInfo("pose_detector.tflite"), detector)
        z.writestr(zipfile.ZipInfo("pose_landmarks_detector.tflite"), landmarks)
    print(out, os.path.getsize(out))

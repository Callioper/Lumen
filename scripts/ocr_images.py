# OCR for the pictures a post prints its text in (server/content/ocr.ts runs it): the engine started
# once, each image path on the command line read in turn. Prints one JSON line per image:
# {"path", "boxes": [{"box": [[x, y] x4], "score", "text"}]} or {"path", "error"}.
# The engine is a module `ocr` in the folder LUMEN_OCR_ENGINE names (设置 → 抓取 → OCR): its Engine is
# a context manager whose recognize(path) gives those boxes. Run with the Python that engine needs.
import json
import os
import sys

sys.path.insert(0, os.environ["LUMEN_OCR_ENGINE"])
sys.stdout.reconfigure(encoding="utf-8")

from ocr import Engine  # noqa: E402


def main(paths):
    with Engine() as engine:
        for path in paths:
            try:
                out = {"path": path, "boxes": engine.recognize(path)}
            except Exception as e:  # one unreadable image costs only itself
                out = {"path": path, "error": str(e)}
            print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])

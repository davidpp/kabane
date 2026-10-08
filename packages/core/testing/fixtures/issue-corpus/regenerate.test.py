"""Optional stdlib-only converter regression: python3 regenerate.test.py."""
import ast
import pathlib
import re
import unittest

# Exercise the real normalizer without importing pyarrow or running conversion.
module = ast.parse(pathlib.Path(__file__).with_name("regenerate.py").read_text())
normalizer = next(node for node in module.body
                  if isinstance(node, ast.FunctionDef) and node.name == "normalize")
namespace = {"re": re, "logins": []}
exec(compile(ast.Module(body=[normalizer], type_ignores=[]), "regenerate.py", "exec"), namespace)
normalize = namespace["normalize"]


class NormalizePaths(unittest.TestCase):
    def test_decoded_windows_paths(self):
        for text, expected in [
            (r"C:\Users\ExamplePerson\file.txt", r"C:\Users\[user]\file.txt"),
            (r"c:\users\exampleperson\cache\data", r"c:\users\[user]\cache\data"),
        ]:
            with self.subTest(text=text):
                self.assertEqual(normalize(text), expected)

    def test_posix_paths(self):
        for text in ["/home/ExamplePerson/file.txt", "/Users/ExamplePerson/file.txt"]:
            with self.subTest(text=text):
                self.assertEqual(normalize(text), "/home/[user]/file.txt")


if __name__ == "__main__":
    unittest.main()

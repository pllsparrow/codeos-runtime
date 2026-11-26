# Shared nested lists

A shallow copy creates a new outer list. Its elements still refer to the same objects.

```python
original = [[1], [2]]
copy = original.copy()
copy[0].append(99)
print(original)
```

Predict the output before running the code. Then replace `copy[0].append(99)` with
`copy[0] = [99]` and run it again. Record which list changed in each case and why.

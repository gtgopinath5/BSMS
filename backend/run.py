#!/usr/bin/env python3
"""Convenience launcher:  python3 run.py   ->  http://localhost:8000/docs"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)

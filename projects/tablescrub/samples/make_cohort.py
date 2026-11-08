#!/usr/bin/env python3
"""Generates samples/cohort.csv: a fully synthetic clinical cohort (no real people).

Deterministic (fixed seed) so the README examples stay reproducible.
Usage: python3 samples/make_cohort.py [rows]
"""
import csv, random, sys, datetime, os

random.seed(42)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 400
first_f = ["Anna", "Mette", "Ida", "Sofie", "Emma", "Freja", "Clara", "Laura", "Maja", "Julie"]
first_m = ["Lars", "Søren", "Mads", "Jonas", "Oliver", "William", "Noah", "Lucas", "Emil", "Frederik"]
last = ["Jensen", "Nielsen", "Hansen", "Pedersen", "Andersen", "Christensen", "Larsen", "Sørensen", "Rasmussen", "Jørgensen"]
cities = [("2100", "København Ø"), ("2200", "København N"), ("2300", "København S"), ("8000", "Aarhus C"),
          ("8200", "Aarhus N"), ("5000", "Odense C"), ("9000", "Aalborg"), ("7100", "Vejle"), ("6700", "Esbjerg")]
diagnoses = ["Hypertension"] * 6 + ["Diabetes type 2"] * 4 + ["Asthma"] * 4 + ["COPD"] * 2 + ["Migraine"] * 3 + ["Sarcoidosis"]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cohort.csv")
with open(out, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["record_id", "first_name", "last_name", "cpr", "email", "date_of_birth", "sex", "zip", "city",
                "admission_date", "diagnosis", "systolic_bp", "bmi", "smoker", "hba1c_mmol_mol"])
    for i in range(N):
        sex = random.choice("FM")
        fn = random.choice(first_f if sex == "F" else first_m)
        ln = random.choice(last)
        dob = datetime.date(1940, 1, 1) + datetime.timedelta(days=random.randint(0, 365 * 62))
        seq = random.randint(0, 999) * 10 + (0 if sex == "F" else 1)  # last digit parity encodes sex, as in real CPR
        cpr = f"{dob:%d%m%y}-{seq:04d}"
        z, city = random.choice(cities)
        adm = datetime.date(2023, 1, 1) + datetime.timedelta(days=random.randint(0, 600))
        dx = random.choice(diagnoses)
        bp = int(random.gauss(135 if dx == "Hypertension" else 122, 12))
        bmi = round(random.gauss(27, 4), 1)
        hba1c = round(random.gauss(58 if dx.startswith("Diabetes") else 37, 6), 0) if random.random() > 0.1 else ""
        w.writerow([f"R{100000 + i}", fn, ln, cpr, f"{fn.lower()}.{ln.lower()}{i}@example.org".replace("ø", "o"),
                    dob.isoformat(), sex, z, city, adm.isoformat(), dx, bp, bmi,
                    random.choice(["yes", "no", "no", "no"]), int(hba1c) if hba1c != "" else ""])
print(f"wrote {N} rows to {out}")

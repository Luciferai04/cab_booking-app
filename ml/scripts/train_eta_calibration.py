import argparse
import pandas as pd
import numpy as np
from sklearn.linear_model import LinearRegression
from joblib import dump

# Simple ETA calibration trainer: learn factor mapping OSRM durations to actual durations
# Features: osrm_duration, hour, dow

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='Path to trips CSV')
    ap.add_argument('--output', required=True, help='Path to save model joblib')
    args = ap.parse_args()

    df = pd.read_csv(args.input)
    df['pickup_ts'] = pd.to_datetime(df['pickup_ts'])
    df['hour'] = df['pickup_ts'].dt.hour
    df['dow'] = df['pickup_ts'].dt.dayofweek

    X = df[['osrm_duration','hour','dow']].fillna(0).values
    y = df['actual_duration'].values

    model = LinearRegression()
    model.fit(X, y)

    dump(model, args.output)
    print(f'Saved ETA calibration model to {args.output}')

if __name__ == '__main__':
    main()


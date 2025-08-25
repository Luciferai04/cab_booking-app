import argparse
import pandas as pd
from joblib import dump

# Very simple frequency model for demand per (zone, hour-of-week)
# Input CSV should have columns: ts, zone_id, trips
# Produces a dict {(zone_id, how): average_trips}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='Path to demand CSV')
    ap.add_argument('--output', required=True, help='Path to save model joblib')
    args = ap.parse_args()

    df = pd.read_csv(args.input)
    df['ts'] = pd.to_datetime(df['ts'])
    df['how'] = df['ts'].dt.dayofweek * 24 + df['ts'].dt.hour
    g = df.groupby(['zone_id','how'])['trips'].mean().reset_index()
    model = {(row['zone_id'], int(row['how'])): float(row['trips']) for _, row in g.iterrows()}
    dump(model, args.output)
    print(f'Saved demand model to {args.output}')

if __name__ == '__main__':
    main()

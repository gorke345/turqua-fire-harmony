import pandas as pd
import json
import math
import os

# Türkiye Sınır Kutusu (Batı, Güney, Doğu, Kuzey) - Küresel için "world" yazabilirsin
BBOX_TURKEY = "25.6,35.8,44.8,42.1"
DAYS = 3  # Son kaç günün verisi çekilsin (1 ile 10 arası)

def fetch_sensor_data(sensor_name, bbox=BBOX_TURKEY, days=DAYS):
    map_key = os.environ.get("NASA_FIRMS_MAP_KEY", "").strip()
    if not map_key:
        raise RuntimeError("NASA_FIRMS_MAP_KEY ortam değişkeni tanımlı değil.")
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{map_key}/{sensor_name}/{bbox}/{days}"
    print(f"[*] {sensor_name} verisi çekiliyor...")
    try:
        df = pd.read_csv(url)
        df["sensor_source"] = sensor_name
        return df
    except Exception as e:
        raise RuntimeError(f"FIRMS verisi alınamadı ({sensor_name}): {e}") from e

def normalize_schema(df, sensor_type):
    """MODIS ve VIIRS sütunlarını ortak mühendislik şemasına eşitler."""
    if df.empty:
        return df

    normalized = pd.DataFrame()
    normalized["latitude"] = pd.to_numeric(df["latitude"], errors="coerce")
    normalized["longitude"] = pd.to_numeric(df["longitude"], errors="coerce")
    normalized["scan_km"] = pd.to_numeric(df["scan"], errors="coerce")
    normalized["track_km"] = pd.to_numeric(df["track"], errors="coerce")
    normalized["acq_date"] = df["acq_date"].astype(str)
    normalized["acq_time"] = df["acq_time"].astype(str).str.zfill(4)
    normalized["frp_mw"] = pd.to_numeric(df["frp"], errors="coerce")
    normalized["daynight"] = df["daynight"].astype(str).str.upper()
    normalized["satellite"] = df["sensor_source"]

    if sensor_type == "MODIS":
        normalized["sensor"] = "MODIS"
        normalized["temp_k"] = pd.to_numeric(df["brightness"], errors="coerce")
        normalized["temp_bg_k"] = pd.to_numeric(df["bright_t31"], errors="coerce")
        normalized["confidence"] = pd.to_numeric(df["confidence"], errors="coerce")
    else:  # VIIRS
        normalized["sensor"] = "VIIRS"
        normalized["temp_k"] = pd.to_numeric(df["bright_ti4"], errors="coerce")
        normalized["temp_bg_k"] = pd.to_numeric(df["bright_ti5"], errors="coerce")
        normalized["confidence"] = df["confidence"]

    confidence_text = normalized["confidence"].astype(str).str.strip().str.lower()
    numeric_confidence = pd.to_numeric(normalized["confidence"], errors="coerce")
    confidence_valid = numeric_confidence.between(0, 100) | confidence_text.isin(
        ("l", "n", "h", "low", "nominal", "high")
    )

    valid = (
        normalized["latitude"].between(-90, 90)
        & normalized["longitude"].between(-180, 180)
        & (normalized["scan_km"] > 0)
        & (normalized["track_km"] > 0)
        & (normalized["frp_mw"] >= 0)
        & (normalized["temp_k"] > 0)
        & (normalized["temp_bg_k"] > 0)
        & confidence_valid
        & normalized["daynight"].isin(("D", "N"))
        & normalized["acq_date"].ne("nan")
        & normalized["acq_time"].ne("nan")
    )
    skipped = len(normalized) - int(valid.sum())
    if skipped:
        print(f"[!] {skipped} eksik veya geçersiz {sensor_type} kaydı atlandı.")
    return normalized.loc[valid].reset_index(drop=True)

def haversine_km(lat1, lon1, lat2, lon2):
    """İki koordinat arasındaki gerçek küresel mesafeyi (km) hesaplar."""
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))

if __name__ == "__main__":
    # 1. Verileri Çek
    df_modis = normalize_schema(fetch_sensor_data("MODIS_NRT"), "MODIS")
    df_viirs = normalize_schema(fetch_sensor_data("VIIRS_SNPP_NRT"), "VIIRS")
    
    # 2. Tek Tabloda Birleştir
    combined_df = pd.concat([df_modis, df_viirs], ignore_index=True)
    print(f"[+] Toplam {len(combined_df)} sıcak nokta başarıyla normalize edildi.")
    
    # 3. Web Haritasının Okuyacağı JSON Olarak Kaydet
    combined_df.to_json("raw_and_normalized_hotspots.json", orient="records", indent=2)
    print("[+] 'raw_and_normalized_hotspots.json' oluşturuldu!")
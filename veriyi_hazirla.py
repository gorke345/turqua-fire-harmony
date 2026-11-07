import shapefile  # pyshp
import json
import os

TARGET_FILES = {
    "MODIS": ["fire_nrt_M-C61_817180.dbf", "fire_archive_M-C61_817180.dbf"],
    "VIIRS_SNPP": ["fire_nrt_SV-C2_817184.dbf", "fire_archive_SV-C2_817184.dbf"],
    "VIIRS_NOAA20": ["fire_nrt_J1V-C2_817182.dbf", "fire_archive_J1V-C2_817182.dbf"],
    "VIIRS_NOAA21": ["fire_nrt_J2V-C2_817183.dbf"]
}

# Türkiye Sınır Kutusu
TR_MIN_LON, TR_MIN_LAT, TR_MAX_LON, TR_MAX_LAT = 25.6, 35.8, 44.8, 42.1

# DENGELENMİŞ LİMİTLER: Türkiye 800 (4x200), Küresel 5200 (4x1300) = Toplam 6000 Nokta
MAX_TR_PER_SENSOR = 200
MAX_GLOBAL_PER_SENSOR = 1300

def find_file_automatically(filename):
    user_home = os.path.expanduser("~")
    search_dirs = [os.getcwd(), os.path.join(user_home, "Downloads"), os.path.join(user_home, "Desktop")]
    for base_dir in search_dirs:
        if not os.path.exists(base_dir):
            continue
        for root, _, files in os.walk(base_dir):
            if filename in files:
                return os.path.join(root, filename)
    return None

def parse_record(row, sensor_type, region_tag):
    lat = float(row.get("latitude", 0))
    lon = float(row.get("longitude", 0))

    if sensor_type == "MODIS":
        temp_k = float(row.get("brightness", 0))
        temp_bg = float(row.get("bright_t31", 0))
        confidence = row.get("confidence")
    else:
        temp_k = float(row.get("bright_ti4", row.get("brightness", 0)))
        temp_bg = float(row.get("bright_ti5", row.get("bright_t31", 0)))
        confidence = row.get("confidence")
    if isinstance(confidence, str):
        confidence = confidence.strip()

    return {
        "sensor": sensor_type,
        "region": region_tag,
        "lat": round(lat, 5),
        "lon": round(lon, 5),
        "scan_km": float(row.get("scan", 1.0)),
        "track_km": float(row.get("track", 1.0)),
        "temp_k": round(temp_k, 2),
        "temp_bg_k": round(temp_bg, 2),
        "frp_mw": round(float(row.get("frp", 0)), 2),
        "confidence": confidence,
        "acq_date": str(row.get("acq_date", "")),
        "acq_time": str(row.get("acq_time", "")).zfill(4),
        "daynight": str(row.get("daynight", "D"))
    }

def process_sensor_files(file_list, sensor_type):
    tr_points = []
    global_points = []

    for fname in file_list:
        full_path = find_file_automatically(fname)
        if not full_path:
            continue

        print(f"[*] {fname} dengeli modda okunuyor...")
        try:
            sf = shapefile.Reader(full_path)
            fields = [field[0].lower() for field in sf.fields[1:]]
            total_records = len(sf)
            # Dosyanın tamamına eşit dağılmış küresel örnekleme adımı
            step = max(1, total_records // (MAX_GLOBAL_PER_SENSOR * 2))

            for idx, rec in enumerate(sf.iterRecords()):
                row = dict(zip(fields, rec))
                lat = float(row.get("latitude", 0))
                lon = float(row.get("longitude", 0))

                if TR_MIN_LAT <= lat <= TR_MAX_LAT and TR_MIN_LON <= lon <= TR_MAX_LON:
                    if len(tr_points) < MAX_TR_PER_SENSOR:
                        tr_points.append(parse_record(row, sensor_type, "TR"))
                elif idx % step == 0 and len(global_points) < MAX_GLOBAL_PER_SENSOR:
                    global_points.append(parse_record(row, sensor_type, "GLOBAL"))

                if len(tr_points) >= MAX_TR_PER_SENSOR and len(global_points) >= MAX_GLOBAL_PER_SENSOR:
                    break

            print(f"    -> {sensor_type}: {len(tr_points)} Türkiye, {len(global_points)} Küresel nokta alındı.")
            if len(tr_points) > 0 or len(global_points) > 0:
                break
        except Exception as e:
            print(f"[!] Hata ({fname}): {e}")

    return tr_points + global_points

if __name__ == "__main__":
    all_points = []
    for sensor_type, file_list in TARGET_FILES.items():
        all_points.extend(process_sensor_files(file_list, sensor_type))

    with open("harmonized_fires.json", "w", encoding="utf-8") as f:
        json.dump(all_points, f, ensure_ascii=False, indent=2)

    print(f"\n[BAŞARILI] Dengelenmiş {len(all_points)} nokta 'harmonized_fires.json' dosyasına yazıldı!")
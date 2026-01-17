"""Seed script for Equipment v2 database.

Creates sample data for development and testing:
- Warehouse + sample hotel locations
- Equipment types with parts relationships
- Individual equipment items with serial numbers
- Sample requests in various states
"""

import argparse
from datetime import date, timedelta

from sqlalchemy.orm import Session

from .database import SessionLocal, engine, Base
from .models import (
    Location, EquipmentType, EquipmentItem, Request, RequestLine,
    equipment_type_parts, ItemCondition, LocationType, RequestStatus
)


def clear_data(db: Session) -> None:
    """Clear all existing data."""
    db.execute(equipment_type_parts.delete())
    db.query(RequestLine).delete()
    db.query(Request).delete()
    db.query(EquipmentItem).delete()
    db.query(EquipmentType).delete()
    db.query(Location).delete()
    db.commit()
    print("✓ Cleared existing data")


def seed_locations(db: Session) -> dict[str, Location]:
    """Create warehouse and sample hotel locations."""
    locations_data = [
        # Warehouse
        {"branch_id": "0000", "name": "Dallas Warehouse", "address": "123 Industrial Blvd, Dallas, TX 75001", "region": "Central"},
        # Hotels
        {"branch_id": "0101", "name": "Austin Grand Hotel", "address": "456 Congress Ave, Austin, TX 78701", "region": "Central"},
        {"branch_id": "0102", "name": "Houston Plaza", "address": "789 Main St, Houston, TX 77002", "region": "Central"},
        {"branch_id": "0201", "name": "Phoenix Resort", "address": "321 Desert Rd, Phoenix, AZ 85001", "region": "West"},
        {"branch_id": "0202", "name": "Los Angeles Convention Center Hotel", "address": "555 Figueroa St, Los Angeles, CA 90071", "region": "West"},
        {"branch_id": "0301", "name": "Miami Beach Resort", "address": "100 Ocean Dr, Miami, FL 33139", "region": "East"},
        {"branch_id": "0302", "name": "Orlando Conference Center", "address": "200 International Dr, Orlando, FL 32819", "region": "East"},
        {"branch_id": "0401", "name": "Chicago Downtown Hotel", "address": "333 Michigan Ave, Chicago, IL 60601", "region": "North"},
        {"branch_id": "0402", "name": "Denver Mountain Lodge", "address": "444 Rocky Mountain Blvd, Denver, CO 80202", "region": "North"},
    ]

    locations = {}
    for data in locations_data:
        loc = Location(**data)
        db.add(loc)
        locations[data["branch_id"]] = loc

    db.commit()
    print(f"✓ Created {len(locations)} locations")
    return locations


def seed_equipment_types(db: Session) -> dict[str, EquipmentType]:
    """Create equipment types with categories."""
    types_data = [
        # AV Equipment
        {"name": "Projector - 5000 Lumens", "category": "AV Equipment", "description": "High brightness projector for large venues"},
        {"name": "Projector - 3000 Lumens", "category": "AV Equipment", "description": "Standard projector for meeting rooms"},
        {"name": "Projection Screen - 120\"", "category": "AV Equipment", "description": "Motorized projection screen"},
        {"name": "Projection Screen - 84\"", "category": "AV Equipment", "description": "Tripod projection screen"},
        {"name": "Wireless Microphone Kit", "category": "AV Equipment", "description": "Handheld + lavalier wireless mic set"},
        {"name": "PA Speaker System", "category": "AV Equipment", "description": "Powered speakers with stands"},
        {"name": "Audio Mixer - 12 Channel", "category": "AV Equipment", "description": "Professional audio mixer"},
        {"name": "HDMI Cable - 25ft", "category": "AV Equipment", "description": "High-speed HDMI cable"},
        {"name": "VGA Cable - 25ft", "category": "AV Equipment", "description": "VGA cable for legacy connections"},

        # Furniture
        {"name": "Folding Table - 6ft", "category": "Furniture", "description": "Rectangle folding table"},
        {"name": "Folding Table - 8ft", "category": "Furniture", "description": "Large rectangle folding table"},
        {"name": "Round Table - 60\"", "category": "Furniture", "description": "Banquet round table"},
        {"name": "Folding Chair", "category": "Furniture", "description": "Padded folding chair"},
        {"name": "Cocktail Table", "category": "Furniture", "description": "High-top cocktail table"},
        {"name": "Tablecloth - 6ft", "category": "Furniture", "description": "White tablecloth for 6ft table"},
        {"name": "Tablecloth - 8ft", "category": "Furniture", "description": "White tablecloth for 8ft table"},

        # Staging
        {"name": "Stage Deck - 4x8", "category": "Staging", "description": "4x8 ft stage platform"},
        {"name": "Stage Riser - 8\"", "category": "Staging", "description": "8 inch riser for stage deck"},
        {"name": "Stage Riser - 16\"", "category": "Staging", "description": "16 inch riser for stage deck"},
        {"name": "Stage Skirt - Black", "category": "Staging", "description": "Black pleated stage skirting"},
        {"name": "Podium - Acrylic", "category": "Staging", "description": "Clear acrylic lectern"},
        {"name": "Podium - Wood", "category": "Staging", "description": "Wooden lectern with shelf"},

        # Lighting
        {"name": "Uplighting Kit - LED", "category": "Lighting", "description": "Set of 4 LED uplights with controller"},
        {"name": "Par Can Light", "category": "Lighting", "description": "LED par can stage light"},
        {"name": "Truss Section - 10ft", "category": "Lighting", "description": "Aluminum lighting truss"},
        {"name": "Lighting Stand", "category": "Lighting", "description": "Tripod stand for lights"},

        # Accessories
        {"name": "Extension Cord - 50ft", "category": "Accessories", "description": "Heavy duty extension cord"},
        {"name": "Power Strip - 6 outlet", "category": "Accessories", "description": "Surge protected power strip"},
        {"name": "Gaffer Tape - Black", "category": "Accessories", "description": "2 inch black gaffer tape"},
        {"name": "Easel - Display", "category": "Accessories", "description": "Adjustable display easel"},
    ]

    types = {}
    for data in types_data:
        eq_type = EquipmentType(**data)
        db.add(eq_type)
        types[data["name"]] = eq_type

    db.commit()
    print(f"✓ Created {len(types)} equipment types")
    return types


def seed_parts_relationships(db: Session, types: dict[str, EquipmentType]) -> None:
    """Create parts relationships between equipment types."""
    # Projector kits include cables
    relationships = [
        # 5000 lumen projector needs screen and cables
        ("Projector - 5000 Lumens", "Projection Screen - 120\"", False, 1),
        ("Projector - 5000 Lumens", "HDMI Cable - 25ft", True, 1),
        ("Projector - 5000 Lumens", "VGA Cable - 25ft", False, 1),
        ("Projector - 5000 Lumens", "Extension Cord - 50ft", True, 1),

        # 3000 lumen projector needs smaller screen
        ("Projector - 3000 Lumens", "Projection Screen - 84\"", False, 1),
        ("Projector - 3000 Lumens", "HDMI Cable - 25ft", True, 1),
        ("Projector - 3000 Lumens", "Extension Cord - 50ft", True, 1),

        # PA system needs mixer
        ("PA Speaker System", "Audio Mixer - 12 Channel", False, 1),
        ("PA Speaker System", "Wireless Microphone Kit", False, 1),
        ("PA Speaker System", "Extension Cord - 50ft", True, 2),

        # Stage deck needs risers and skirting
        ("Stage Deck - 4x8", "Stage Riser - 8\"", False, 4),
        ("Stage Deck - 4x8", "Stage Skirt - Black", True, 1),

        # Uplighting needs stands
        ("Uplighting Kit - LED", "Lighting Stand", False, 4),
        ("Uplighting Kit - LED", "Extension Cord - 50ft", True, 2),

        # Tables need tablecloths
        ("Folding Table - 6ft", "Tablecloth - 6ft", False, 1),
        ("Folding Table - 8ft", "Tablecloth - 8ft", False, 1),
    ]

    for parent_name, part_name, required, quantity in relationships:
        parent = types.get(parent_name)
        part = types.get(part_name)
        if parent and part:
            db.execute(
                equipment_type_parts.insert().values(
                    parent_type_id=parent.id,
                    part_type_id=part.id,
                    required=required,
                    quantity=quantity
                )
            )

    db.commit()
    print(f"✓ Created {len(relationships)} parts relationships")


def seed_equipment_items(db: Session, types: dict[str, EquipmentType], locations: dict[str, Location]) -> list[EquipmentItem]:
    """Create individual equipment items with serial numbers."""
    items = []
    item_counter = 1

    # Distribution: most items at warehouse, some at hotels
    warehouse = locations["0000"]
    hotels = [loc for branch, loc in locations.items() if branch != "0000"]

    # High-value items (fewer quantity, mostly warehouse)
    high_value_types = [
        "Projector - 5000 Lumens",
        "Projector - 3000 Lumens",
        "Audio Mixer - 12 Channel",
        "PA Speaker System",
    ]

    for type_name in high_value_types:
        eq_type = types.get(type_name)
        if not eq_type:
            continue

        # 5 at warehouse
        for i in range(5):
            item = EquipmentItem(
                equipment_type_id=eq_type.id,
                serial_number=f"SN-{item_counter:05d}",
                barcode=f"BC-{item_counter:08d}",
                condition=ItemCondition.GOOD.value if i > 0 else ItemCondition.NEW.value,
                location_type=LocationType.WAREHOUSE.value,
                location_id=warehouse.id
            )
            db.add(item)
            items.append(item)
            item_counter += 1

        # 1-2 at some hotels
        for hotel in hotels[:3]:
            item = EquipmentItem(
                equipment_type_id=eq_type.id,
                serial_number=f"SN-{item_counter:05d}",
                barcode=f"BC-{item_counter:08d}",
                condition=ItemCondition.GOOD.value,
                location_type=LocationType.HOTEL.value,
                location_id=hotel.id
            )
            db.add(item)
            items.append(item)
            item_counter += 1

    # Medium-value items (moderate quantity)
    medium_value_types = [
        "Wireless Microphone Kit",
        "Projection Screen - 120\"",
        "Projection Screen - 84\"",
        "Uplighting Kit - LED",
        "Podium - Acrylic",
        "Podium - Wood",
    ]

    for type_name in medium_value_types:
        eq_type = types.get(type_name)
        if not eq_type:
            continue

        # 10 at warehouse
        for i in range(10):
            condition = ItemCondition.NEW.value if i < 3 else (
                ItemCondition.GOOD.value if i < 8 else ItemCondition.FAIR.value
            )
            item = EquipmentItem(
                equipment_type_id=eq_type.id,
                serial_number=f"SN-{item_counter:05d}",
                barcode=f"BC-{item_counter:08d}",
                condition=condition,
                location_type=LocationType.WAREHOUSE.value,
                location_id=warehouse.id
            )
            db.add(item)
            items.append(item)
            item_counter += 1

    # Bulk items (no serial numbers, high quantity)
    bulk_types = [
        ("Folding Chair", 200),
        ("Folding Table - 6ft", 50),
        ("Folding Table - 8ft", 30),
        ("Round Table - 60\"", 40),
        ("HDMI Cable - 25ft", 50),
        ("Extension Cord - 50ft", 100),
        ("Power Strip - 6 outlet", 80),
    ]

    for type_name, qty in bulk_types:
        eq_type = types.get(type_name)
        if not eq_type:
            continue

        # Most at warehouse
        warehouse_qty = int(qty * 0.7)
        for i in range(warehouse_qty):
            item = EquipmentItem(
                equipment_type_id=eq_type.id,
                barcode=f"BC-{item_counter:08d}",
                condition=ItemCondition.GOOD.value,
                location_type=LocationType.WAREHOUSE.value,
                location_id=warehouse.id
            )
            db.add(item)
            items.append(item)
            item_counter += 1

        # Rest distributed to hotels
        remaining = qty - warehouse_qty
        per_hotel = remaining // len(hotels)
        for hotel in hotels:
            for i in range(per_hotel):
                item = EquipmentItem(
                    equipment_type_id=eq_type.id,
                    barcode=f"BC-{item_counter:08d}",
                    condition=ItemCondition.GOOD.value,
                    location_type=LocationType.HOTEL.value,
                    location_id=hotel.id
                )
                db.add(item)
                items.append(item)
                item_counter += 1

    db.commit()
    print(f"✓ Created {len(items)} equipment items")
    return items


def seed_requests(db: Session, types: dict[str, EquipmentType], locations: dict[str, Location]) -> None:
    """Create sample requests in various states."""
    warehouse = locations["0000"]
    austin = locations["0101"]
    houston = locations["0102"]
    phoenix = locations["0201"]
    miami = locations["0301"]

    today = date.today()

    requests_data = [
        # Submitted request - Austin needs projector
        {
            "requesting_location": austin,
            "source_location": warehouse,
            "requester_user_id": "0101",
            "status": RequestStatus.SUBMITTED.value,
            "needed_from_date": today + timedelta(days=7),
            "needed_until_date": today + timedelta(days=10),
            "notes": "Annual sales conference - need high brightness projector",
            "lines": [
                {"type": "Projector - 5000 Lumens", "qty": 1},
                {"type": "Projection Screen - 120\"", "qty": 1},
                {"type": "Wireless Microphone Kit", "qty": 2},
            ]
        },
        # Approved request - Houston getting chairs
        {
            "requesting_location": houston,
            "source_location": warehouse,
            "requester_user_id": "0102",
            "status": RequestStatus.APPROVED.value,
            "needed_from_date": today + timedelta(days=3),
            "needed_until_date": today + timedelta(days=5),
            "notes": "Wedding reception setup",
            "lines": [
                {"type": "Folding Chair", "qty": 100},
                {"type": "Round Table - 60\"", "qty": 10},
                {"type": "Uplighting Kit - LED", "qty": 2},
            ]
        },
        # Fulfilled request - Phoenix has equipment
        {
            "requesting_location": phoenix,
            "source_location": warehouse,
            "requester_user_id": "0201",
            "status": RequestStatus.FULFILLED.value,
            "needed_from_date": today - timedelta(days=2),
            "needed_until_date": today + timedelta(days=5),
            "notes": "Tech conference",
            "lines": [
                {"type": "Projector - 3000 Lumens", "qty": 2},
                {"type": "PA Speaker System", "qty": 1},
            ]
        },
        # Denied request
        {
            "requesting_location": miami,
            "source_location": warehouse,
            "requester_user_id": "0301",
            "status": RequestStatus.DENIED.value,
            "needed_from_date": today + timedelta(days=1),
            "needed_until_date": today + timedelta(days=3),
            "notes": "Last minute request",
            "lines": [
                {"type": "Stage Deck - 4x8", "qty": 10},
            ]
        },
        # Hotel-to-hotel transfer request (submitted)
        {
            "requesting_location": miami,
            "source_location": austin,
            "requester_user_id": "0301",
            "status": RequestStatus.SUBMITTED.value,
            "needed_from_date": today + timedelta(days=14),
            "needed_until_date": None,  # Permanent transfer
            "notes": "Transfer request - Miami needs more capacity",
            "lines": [
                {"type": "Folding Table - 6ft", "qty": 5},
            ]
        },
    ]

    request_count = 0
    for req_data in requests_data:
        request = Request(
            requesting_location_id=req_data["requesting_location"].id,
            source_location_id=req_data["source_location"].id,
            requester_user_id=req_data["requester_user_id"],
            status=req_data["status"],
            needed_from_date=req_data["needed_from_date"],
            needed_until_date=req_data["needed_until_date"],
            notes=req_data["notes"]
        )
        db.add(request)
        db.flush()

        for line_data in req_data["lines"]:
            eq_type = types.get(line_data["type"])
            if eq_type:
                line = RequestLine(
                    request_id=request.id,
                    equipment_type_id=eq_type.id,
                    quantity=line_data["qty"],
                    include_parts=True
                )
                db.add(line)

        request_count += 1

    db.commit()
    print(f"✓ Created {request_count} sample requests")


def main():
    """Run the seed script."""
    parser = argparse.ArgumentParser(description="Seed Equipment v2 database")
    parser.add_argument("--clear", action="store_true", help="Clear existing data first")
    args = parser.parse_args()

    print("Equipment v2 Seed Script")
    print("=" * 40)

    # Create tables if they don't exist
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        if args.clear:
            clear_data(db)

        # Check if data already exists
        existing_locations = db.query(Location).count()
        if existing_locations > 0 and not args.clear:
            print(f"Database already has {existing_locations} locations.")
            print("Use --clear to reset and reseed.")
            return

        # Seed in order
        locations = seed_locations(db)
        types = seed_equipment_types(db)
        seed_parts_relationships(db, types)
        seed_equipment_items(db, types, locations)
        seed_requests(db, types, locations)

        print("=" * 40)
        print("✓ Seed complete!")

    finally:
        db.close()


if __name__ == "__main__":
    main()

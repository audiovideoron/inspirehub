"""Seed script to populate equipment table with sample data."""

import sys
from pathlib import Path

# Add parent directory to path so we can import as package
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from datetime import datetime, UTC
from equipment.database import SessionLocal
from equipment.models import Equipment


def seed_equipment():
    """Add sample equipment data."""
    db = SessionLocal()

    # Check if already seeded
    if db.query(Equipment).first():
        print("Database already has equipment data, skipping seed.")
        db.close()
        return

    sample_equipment = [
        Equipment(
            name="Projector - Epson PowerLite",
            category="AV Equipment",
            total_count=10,
            description="4000 lumen projector with HDMI input",
        ),
        Equipment(
            name="Microphone - Shure SM58",
            category="Audio",
            total_count=20,
            description="Dynamic vocal microphone",
        ),
        Equipment(
            name="Speaker - JBL EON615",
            category="Audio",
            total_count=12,
            description="15\" two-way powered speaker",
        ),
        Equipment(
            name="Laptop - Dell Latitude",
            category="Computers",
            total_count=8,
            description="Windows laptop for presentations",
        ),
        Equipment(
            name="HDMI Cable - 25ft",
            category="Cables",
            total_count=50,
            description="High-speed HDMI cable",
        ),
        Equipment(
            name="Mixer - Yamaha MG12",
            category="Audio",
            total_count=5,
            description="12-channel analog mixer",
        ),
        Equipment(
            name="Wireless Mic - Sennheiser EW 100",
            category="Audio",
            total_count=15,
            description="Handheld wireless microphone system",
        ),
        Equipment(
            name="Tripod Screen - 100\"",
            category="AV Equipment",
            total_count=8,
            description="Portable tripod projection screen",
        ),
    ]

    for item in sample_equipment:
        item.created_at = datetime.now(UTC)
        item.updated_at = datetime.now(UTC)
        db.add(item)

    db.commit()
    print(f"Added {len(sample_equipment)} equipment items.")
    db.close()


if __name__ == "__main__":
    seed_equipment()

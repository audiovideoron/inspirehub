"""Pytest configuration and shared fixtures for equipment API tests."""

import pytest
from datetime import date, timedelta
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from equipment.database import Base, get_db
from equipment.api import app
from equipment.models import (
    Location, EquipmentType, EquipmentItem, Request, RequestLine,
    ItemCondition, LocationType, RequestStatus
)


# Use in-memory SQLite for tests
SQLALCHEMY_TEST_DATABASE_URL = "sqlite:///:memory:"


@pytest.fixture(scope="function")
def test_db():
    """Create a fresh test database for each test."""
    engine = create_engine(
        SQLALCHEMY_TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    # Create all tables
    Base.metadata.create_all(bind=engine)

    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="function")
def client(test_db):
    """Create a test client with the test database."""
    def override_get_db():
        try:
            yield test_db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def warehouse(test_db):
    """Create a warehouse location (branch 0000)."""
    location = Location(
        branch_id="0000",
        name="Central Warehouse",
        address="100 Warehouse Way, Dallas, TX 75001",
        region="Central"
    )
    test_db.add(location)
    test_db.commit()
    test_db.refresh(location)
    return location


@pytest.fixture
def hotel_location(test_db):
    """Create a hotel location."""
    location = Location(
        branch_id="0479",
        name="Test Hotel",
        address="479 Test St, Test City, TX 75000",
        region="North"
    )
    test_db.add(location)
    test_db.commit()
    test_db.refresh(location)
    return location


@pytest.fixture
def second_hotel(test_db):
    """Create a second hotel location."""
    location = Location(
        branch_id="0101",
        name="Second Hotel",
        address="101 Other St, Other City, TX 75002",
        region="South"
    )
    test_db.add(location)
    test_db.commit()
    test_db.refresh(location)
    return location


@pytest.fixture
def equipment_type(test_db):
    """Create a basic equipment type."""
    eq_type = EquipmentType(
        name="Projector",
        category="AV Equipment",
        description="Standard meeting room projector"
    )
    test_db.add(eq_type)
    test_db.commit()
    test_db.refresh(eq_type)
    return eq_type


@pytest.fixture
def equipment_type_with_parts(test_db, equipment_type):
    """Create an equipment type with parts (HDMI Cable)."""
    # Create part type
    part_type = EquipmentType(
        name="HDMI Cable",
        category="Cables",
        description="6ft HDMI cable"
    )
    test_db.add(part_type)
    test_db.commit()
    test_db.refresh(part_type)

    # Add as part to main equipment type
    from equipment.models import equipment_type_parts
    test_db.execute(
        equipment_type_parts.insert().values(
            parent_type_id=equipment_type.id,
            part_type_id=part_type.id,
            required=True,
            quantity=1
        )
    )
    test_db.commit()

    return equipment_type, part_type


@pytest.fixture
def equipment_item(test_db, equipment_type, warehouse):
    """Create an equipment item at the warehouse."""
    item = EquipmentItem(
        equipment_type_id=equipment_type.id,
        serial_number="PROJ-001",
        barcode="BC001",
        condition=ItemCondition.NEW.value,
        location_type=LocationType.WAREHOUSE.value,
        location_id=warehouse.id
    )
    test_db.add(item)
    test_db.commit()
    test_db.refresh(item)
    return item


@pytest.fixture
def multiple_items(test_db, equipment_type, warehouse):
    """Create multiple equipment items at the warehouse."""
    items = []
    for i in range(3):
        item = EquipmentItem(
            equipment_type_id=equipment_type.id,
            serial_number=f"PROJ-{i+1:03d}",
            barcode=f"BC{i+1:03d}",
            condition=ItemCondition.NEW.value,
            location_type=LocationType.WAREHOUSE.value,
            location_id=warehouse.id
        )
        test_db.add(item)
        items.append(item)
    test_db.commit()
    for item in items:
        test_db.refresh(item)
    return items


@pytest.fixture
def submitted_request(test_db, hotel_location, warehouse, equipment_type):
    """Create a submitted equipment request."""
    request = Request(
        requesting_location_id=hotel_location.id,
        source_location_id=warehouse.id,
        requester_user_id="test_user",
        status=RequestStatus.SUBMITTED.value,
        needed_from_date=date.today() + timedelta(days=7),
        needed_until_date=date.today() + timedelta(days=14),
        notes="Test request"
    )
    test_db.add(request)
    test_db.flush()

    line = RequestLine(
        request_id=request.id,
        equipment_type_id=equipment_type.id,
        quantity=1,
        include_parts=True
    )
    test_db.add(line)
    test_db.commit()
    test_db.refresh(request)
    return request

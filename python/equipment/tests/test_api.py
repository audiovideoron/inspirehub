"""Comprehensive tests for Equipment API endpoints."""

import pytest
from datetime import date, timedelta
from fastapi import status

from equipment.models import (
    Location, EquipmentType, EquipmentItem, Request, RequestLine,
    ItemCondition, LocationType, RequestStatus
)


class TestHealthEndpoint:
    """Tests for /api/health endpoint."""

    def test_health_check_returns_ok(self, client):
        """Health check should return status ok and version."""
        response = client.get("/api/health")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["status"] == "ok"
        assert data["version"] == "2.0.0"


class TestLocationEndpoints:
    """Tests for /api/locations endpoints."""

    def test_list_locations_empty(self, client):
        """List locations should return empty list when no locations exist."""
        response = client.get("/api/locations")
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

    def test_list_locations_with_data(self, client, warehouse, hotel_location):
        """List locations should return all locations."""
        response = client.get("/api/locations")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data) == 2
        branch_ids = [loc["branch_id"] for loc in data]
        assert "0000" in branch_ids
        assert "0479" in branch_ids

    def test_list_locations_filter_by_region(self, client, warehouse, hotel_location):
        """List locations should filter by region."""
        response = client.get("/api/locations?region=North")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data) == 1
        assert data[0]["branch_id"] == "0479"

    def test_get_location_by_id(self, client, warehouse):
        """Get location by ID should return the location."""
        response = client.get(f"/api/locations/{warehouse.id}")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["branch_id"] == "0000"
        assert data["name"] == "Central Warehouse"
        assert data["is_warehouse"] is True

    def test_get_location_by_id_not_found(self, client):
        """Get non-existent location should return 404."""
        response = client.get("/api/locations/9999")
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_get_location_by_branch_id(self, client, hotel_location):
        """Get location by branch ID should return the location."""
        response = client.get("/api/locations/branch/0479")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["branch_id"] == "0479"
        assert data["name"] == "Test Hotel"
        assert data["is_warehouse"] is False

    def test_get_location_by_branch_id_not_found(self, client):
        """Get non-existent branch should return 404."""
        response = client.get("/api/locations/branch/9999")
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_create_location(self, client):
        """Create location should succeed with valid data."""
        response = client.post("/api/locations", json={
            "branch_id": "0501",
            "name": "New Hotel",
            "address": "501 New St, New City, TX 75501",
            "region": "East"
        })
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert data["branch_id"] == "0501"
        assert data["name"] == "New Hotel"
        assert data["is_warehouse"] is False
        assert "id" in data

    def test_create_location_duplicate_branch_id(self, client, hotel_location):
        """Create location with duplicate branch ID should fail."""
        response = client.post("/api/locations", json={
            "branch_id": "0479",  # Already exists
            "name": "Duplicate Hotel",
            "address": "123 Dup St",
            "region": "North"
        })
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "already exists" in response.json()["detail"]

    def test_create_location_invalid_branch_id(self, client):
        """Create location with invalid branch ID should fail."""
        response = client.post("/api/locations", json={
            "branch_id": "ABC",  # Not 4 digits
            "name": "Invalid Hotel"
        })
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_update_location(self, client, hotel_location):
        """Update location should succeed."""
        response = client.patch(f"/api/locations/{hotel_location.id}", json={
            "name": "Updated Hotel Name",
            "region": "West"
        })
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["name"] == "Updated Hotel Name"
        assert data["region"] == "West"
        assert data["branch_id"] == "0479"  # Unchanged


class TestEquipmentTypeEndpoints:
    """Tests for /api/equipment-types endpoints."""

    def test_list_equipment_types_empty(self, client):
        """List equipment types should return empty list when none exist."""
        response = client.get("/api/equipment-types")
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

    def test_list_equipment_types_with_data(self, client, equipment_type):
        """List equipment types should return all types."""
        response = client.get("/api/equipment-types")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data) == 1
        assert data[0]["name"] == "Projector"

    def test_list_equipment_types_filter_by_category(self, client, equipment_type):
        """List equipment types should filter by category."""
        response = client.get("/api/equipment-types?category=AV%20Equipment")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data) == 1

        response = client.get("/api/equipment-types?category=Nonexistent")
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

    def test_get_equipment_type_with_parts(self, client, equipment_type_with_parts):
        """Get equipment type should include parts list."""
        parent, part = equipment_type_with_parts
        response = client.get(f"/api/equipment-types/{parent.id}")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["name"] == "Projector"
        assert len(data["parts"]) == 1
        assert data["parts"][0]["name"] == "HDMI Cable"
        assert data["parts"][0]["required"] is True

    def test_get_equipment_type_not_found(self, client):
        """Get non-existent equipment type should return 404."""
        response = client.get("/api/equipment-types/9999")
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_create_equipment_type(self, client):
        """Create equipment type should succeed."""
        response = client.post("/api/equipment-types", json={
            "name": "Laptop",
            "category": "Computing",
            "description": "Business laptop for presentations"
        })
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert data["name"] == "Laptop"
        assert data["category"] == "Computing"

    def test_update_equipment_type(self, client, equipment_type):
        """Update equipment type should succeed."""
        response = client.patch(f"/api/equipment-types/{equipment_type.id}", json={
            "description": "Updated description"
        })
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["description"] == "Updated description"

    def test_add_part_to_equipment_type(self, client, test_db):
        """Add part to equipment type should succeed."""
        # Create parent and part types
        parent = EquipmentType(name="Laptop Kit", category="Computing")
        part = EquipmentType(name="Laptop Charger", category="Accessories")
        test_db.add_all([parent, part])
        test_db.commit()
        test_db.refresh(parent)
        test_db.refresh(part)

        response = client.post(f"/api/equipment-types/{parent.id}/parts", json={
            "part_type_id": part.id,
            "required": True,
            "quantity": 1
        })
        assert response.status_code == status.HTTP_201_CREATED

        # Verify part was added
        get_response = client.get(f"/api/equipment-types/{parent.id}")
        assert len(get_response.json()["parts"]) == 1

    def test_add_self_as_part_fails(self, client, equipment_type):
        """Adding equipment type as its own part should fail."""
        response = client.post(f"/api/equipment-types/{equipment_type.id}/parts", json={
            "part_type_id": equipment_type.id,
            "required": False,
            "quantity": 1
        })
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "own part" in response.json()["detail"]

    def test_remove_part_from_equipment_type(self, client, equipment_type_with_parts):
        """Remove part from equipment type should succeed."""
        parent, part = equipment_type_with_parts
        response = client.delete(f"/api/equipment-types/{parent.id}/parts/{part.id}")
        assert response.status_code == status.HTTP_200_OK

        # Verify part was removed
        get_response = client.get(f"/api/equipment-types/{parent.id}")
        assert len(get_response.json()["parts"]) == 0


class TestEquipmentItemEndpoints:
    """Tests for /api/equipment-items endpoints."""

    def test_list_equipment_items_empty(self, client):
        """List equipment items should return empty list when none exist."""
        response = client.get("/api/equipment-items")
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

    def test_list_equipment_items_with_data(self, client, equipment_item):
        """List equipment items should return all items."""
        response = client.get("/api/equipment-items")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data) == 1
        assert data[0]["serial_number"] == "PROJ-001"

    def test_list_equipment_items_filter_by_type(self, client, equipment_item):
        """List equipment items should filter by equipment type."""
        response = client.get(f"/api/equipment-items?equipment_type_id={equipment_item.equipment_type_id}")
        assert response.status_code == status.HTTP_200_OK
        assert len(response.json()) == 1

        response = client.get("/api/equipment-items?equipment_type_id=9999")
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

    def test_list_equipment_items_filter_by_location(self, client, equipment_item, warehouse):
        """List equipment items should filter by location."""
        response = client.get(f"/api/equipment-items?location_id={warehouse.id}")
        assert response.status_code == status.HTTP_200_OK
        assert len(response.json()) == 1

    def test_list_equipment_items_filter_by_condition(self, client, equipment_item):
        """List equipment items should filter by condition."""
        response = client.get(f"/api/equipment-items?condition={ItemCondition.NEW.value}")
        assert response.status_code == status.HTTP_200_OK
        assert len(response.json()) == 1

    def test_get_equipment_item_detail(self, client, equipment_item):
        """Get equipment item should return details with related data."""
        response = client.get(f"/api/equipment-items/{equipment_item.id}")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["serial_number"] == "PROJ-001"
        assert data["equipment_type"]["name"] == "Projector"
        assert data["location"]["branch_id"] == "0000"

    def test_get_equipment_item_not_found(self, client):
        """Get non-existent equipment item should return 404."""
        response = client.get("/api/equipment-items/9999")
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_create_equipment_item(self, client, equipment_type, warehouse):
        """Create equipment item should succeed."""
        response = client.post("/api/equipment-items", json={
            "equipment_type_id": equipment_type.id,
            "serial_number": "NEW-001",
            "barcode": "BCNEW001",
            "condition": ItemCondition.NEW.value,
            "location_type": LocationType.WAREHOUSE.value,
            "location_id": warehouse.id
        })
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert data["serial_number"] == "NEW-001"

    def test_create_equipment_item_duplicate_serial(self, client, equipment_item, equipment_type, warehouse):
        """Create equipment item with duplicate serial should fail."""
        response = client.post("/api/equipment-items", json={
            "equipment_type_id": equipment_type.id,
            "serial_number": "PROJ-001",  # Already exists
            "location_id": warehouse.id
        })
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "Serial number already exists" in response.json()["detail"]

    def test_create_equipment_item_duplicate_barcode(self, client, equipment_item, equipment_type, warehouse):
        """Create equipment item with duplicate barcode should fail."""
        response = client.post("/api/equipment-items", json={
            "equipment_type_id": equipment_type.id,
            "serial_number": "UNIQUE-001",
            "barcode": "BC001",  # Already exists
            "location_id": warehouse.id
        })
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "Barcode already exists" in response.json()["detail"]

    def test_create_equipment_item_invalid_type(self, client, warehouse):
        """Create equipment item with invalid type should fail."""
        response = client.post("/api/equipment-items", json={
            "equipment_type_id": 9999,  # Doesn't exist
            "serial_number": "NEW-001",
            "location_id": warehouse.id
        })
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_update_equipment_item(self, client, equipment_item):
        """Update equipment item should succeed."""
        response = client.patch(f"/api/equipment-items/{equipment_item.id}", json={
            "condition": ItemCondition.GOOD.value
        })
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["condition"] == ItemCondition.GOOD.value


class TestRequestEndpoints:
    """Tests for /api/requests endpoints."""

    def test_list_requests_empty(self, client):
        """List requests should return empty list when none exist."""
        response = client.get("/api/requests")
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

    def test_list_requests_with_data(self, client, submitted_request):
        """List requests should return all requests."""
        response = client.get("/api/requests")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data) == 1
        assert data[0]["status"] == RequestStatus.SUBMITTED.value

    def test_list_requests_filter_by_status(self, client, submitted_request):
        """List requests should filter by status."""
        response = client.get(f"/api/requests?status={RequestStatus.SUBMITTED.value}")
        assert response.status_code == status.HTTP_200_OK
        assert len(response.json()) == 1

        response = client.get(f"/api/requests?status={RequestStatus.APPROVED.value}")
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

    def test_get_request_detail(self, client, submitted_request):
        """Get request should return full details."""
        response = client.get(f"/api/requests/{submitted_request.id}")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["status"] == RequestStatus.SUBMITTED.value
        assert data["requesting_location"]["branch_id"] == "0479"
        assert data["source_location"]["branch_id"] == "0000"
        assert len(data["lines"]) == 1

    def test_get_request_not_found(self, client):
        """Get non-existent request should return 404."""
        response = client.get("/api/requests/9999")
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_create_request(self, client, hotel_location, warehouse, equipment_type):
        """Create request should succeed."""
        response = client.post("/api/requests", json={
            "requesting_location_id": hotel_location.id,
            "source_location_id": warehouse.id,
            "requester_user_id": "test_user",
            "needed_from_date": (date.today() + timedelta(days=7)).isoformat(),
            "needed_until_date": (date.today() + timedelta(days=14)).isoformat(),
            "notes": "Need for conference",
            "lines": [
                {
                    "equipment_type_id": equipment_type.id,
                    "quantity": 2,
                    "include_parts": True
                }
            ]
        })
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert data["status"] == RequestStatus.SUBMITTED.value
        assert data["notes"] == "Need for conference"

    def test_create_request_invalid_location(self, client, warehouse, equipment_type):
        """Create request with invalid location should fail."""
        response = client.post("/api/requests", json={
            "requesting_location_id": 9999,  # Doesn't exist
            "source_location_id": warehouse.id,
            "needed_from_date": (date.today() + timedelta(days=7)).isoformat(),
            "lines": [{"equipment_type_id": equipment_type.id, "quantity": 1}]
        })
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_create_request_invalid_equipment_type(self, client, hotel_location, warehouse):
        """Create request with invalid equipment type should fail."""
        response = client.post("/api/requests", json={
            "requesting_location_id": hotel_location.id,
            "source_location_id": warehouse.id,
            "needed_from_date": (date.today() + timedelta(days=7)).isoformat(),
            "lines": [{"equipment_type_id": 9999, "quantity": 1}]  # Doesn't exist
        })
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_create_request_no_lines(self, client, hotel_location, warehouse):
        """Create request with no lines should fail."""
        response = client.post("/api/requests", json={
            "requesting_location_id": hotel_location.id,
            "source_location_id": warehouse.id,
            "needed_from_date": (date.today() + timedelta(days=7)).isoformat(),
            "lines": []
        })
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

    def test_approve_request(self, client, submitted_request):
        """Approve submitted request should succeed."""
        response = client.patch(f"/api/requests/{submitted_request.id}", json={
            "status": RequestStatus.APPROVED.value,
            "reviewed_by_user_id": "manager"
        })
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["status"] == RequestStatus.APPROVED.value
        assert data["reviewed_by_user_id"] == "manager"
        assert data["reviewed_at"] is not None

    def test_deny_request(self, client, submitted_request):
        """Deny submitted request should succeed."""
        response = client.patch(f"/api/requests/{submitted_request.id}", json={
            "status": RequestStatus.DENIED.value,
            "reviewed_by_user_id": "manager",
            "denial_reason": "No availability"
        })
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["status"] == RequestStatus.DENIED.value
        assert data["denial_reason"] == "No availability"

    def test_invalid_status_transition(self, client, submitted_request):
        """Invalid status transition should fail."""
        response = client.patch(f"/api/requests/{submitted_request.id}", json={
            "status": RequestStatus.RETURNED.value  # Can't go from Submitted to Returned
        })
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "Cannot transition" in response.json()["detail"]

    def test_fulfill_approved_request(self, client, test_db, submitted_request):
        """Fulfill approved request should succeed."""
        # First approve the request
        client.patch(f"/api/requests/{submitted_request.id}", json={
            "status": RequestStatus.APPROVED.value
        })

        # Then fulfill it
        response = client.patch(f"/api/requests/{submitted_request.id}", json={
            "status": RequestStatus.FULFILLED.value
        })
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["status"] == RequestStatus.FULFILLED.value

    def test_assign_item_to_request_line(self, client, test_db, submitted_request, equipment_item):
        """Assign item to request line should succeed."""
        # Get the line ID
        request_detail = client.get(f"/api/requests/{submitted_request.id}").json()
        line_id = request_detail["lines"][0]["id"]

        response = client.post(
            f"/api/requests/{submitted_request.id}/lines/{line_id}/assign?item_id={equipment_item.id}"
        )
        assert response.status_code == status.HTTP_200_OK

    def test_assign_wrong_type_item_fails(self, client, test_db, submitted_request, warehouse):
        """Assign item of wrong type to request line should fail."""
        # Create a different equipment type and item
        other_type = EquipmentType(name="Screen", category="AV Equipment")
        test_db.add(other_type)
        test_db.commit()
        test_db.refresh(other_type)

        other_item = EquipmentItem(
            equipment_type_id=other_type.id,
            serial_number="SCREEN-001",
            location_id=warehouse.id
        )
        test_db.add(other_item)
        test_db.commit()
        test_db.refresh(other_item)

        # Get the line ID (which is for Projector, not Screen)
        request_detail = client.get(f"/api/requests/{submitted_request.id}").json()
        line_id = request_detail["lines"][0]["id"]

        response = client.post(
            f"/api/requests/{submitted_request.id}/lines/{line_id}/assign?item_id={other_item.id}"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "does not match" in response.json()["detail"]


class TestAvailabilityEndpoints:
    """Tests for /api/availability endpoint."""

    def test_check_availability_no_items(self, client, equipment_type):
        """Check availability with no items should return empty list."""
        response = client.get(f"/api/availability?equipment_type_id={equipment_type.id}")
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

    def test_check_availability_with_items(self, client, multiple_items, equipment_type, warehouse):
        """Check availability should return correct counts."""
        response = client.get(f"/api/availability?equipment_type_id={equipment_type.id}")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data) == 1
        assert data[0]["equipment_type_id"] == equipment_type.id
        assert data[0]["equipment_type_name"] == "Projector"
        assert data[0]["location_id"] == warehouse.id
        assert data[0]["total_items"] == 3
        assert data[0]["available_items"] == 3
        assert data[0]["reserved_items"] == 0

    def test_check_availability_filter_by_location(self, client, multiple_items, equipment_type, warehouse):
        """Check availability should filter by location."""
        response = client.get(
            f"/api/availability?equipment_type_id={equipment_type.id}&location_id={warehouse.id}"
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data) == 1
        assert data[0]["location_id"] == warehouse.id

    def test_check_availability_invalid_type(self, client):
        """Check availability for non-existent type should return 404."""
        response = client.get("/api/availability?equipment_type_id=9999")
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_check_availability_excludes_retired(self, client, test_db, equipment_type, warehouse):
        """Check availability should exclude retired items."""
        # Create items with different conditions
        active_item = EquipmentItem(
            equipment_type_id=equipment_type.id,
            serial_number="ACTIVE-001",
            condition=ItemCondition.GOOD.value,
            location_id=warehouse.id
        )
        retired_item = EquipmentItem(
            equipment_type_id=equipment_type.id,
            serial_number="RETIRED-001",
            condition=ItemCondition.RETIRED.value,
            location_id=warehouse.id
        )
        test_db.add_all([active_item, retired_item])
        test_db.commit()

        response = client.get(f"/api/availability?equipment_type_id={equipment_type.id}")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data) == 1
        assert data[0]["total_items"] == 1  # Only active item counted


class TestRequestFilteringByLocation:
    """Tests for filtering requests by source location."""

    def test_filter_requests_by_source_location(self, client, test_db, hotel_location, warehouse, equipment_type):
        """Filter requests by source location ID."""
        # Create request from hotel to warehouse
        request = Request(
            requesting_location_id=hotel_location.id,
            source_location_id=warehouse.id,
            status=RequestStatus.SUBMITTED.value,
            needed_from_date=date.today() + timedelta(days=7)
        )
        test_db.add(request)
        test_db.flush()
        test_db.add(RequestLine(
            request_id=request.id,
            equipment_type_id=equipment_type.id,
            quantity=1
        ))
        test_db.commit()

        # Filter by source location (warehouse)
        response = client.get(f"/api/requests?source_location_id={warehouse.id}")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert len(data) == 1

        # Filter by different source location (should be empty)
        response = client.get(f"/api/requests?source_location_id={hotel_location.id}")
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

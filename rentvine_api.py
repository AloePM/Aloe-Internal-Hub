"""
rentvine_api.py — Rentvine data fetcher for HOA form filler.
Uses Basic Auth against aloepm.rentvine.com/api/manager
"""

import os
import base64
import requests
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

RENTVINE_BASE = f"https://{os.getenv('RENTVINE_ACCOUNT', 'aloepm')}.rentvine.com/api/manager"
RENTVINE_AUTH = base64.b64encode(
    f"{os.getenv('RENTVINE_API_KEY', '')}:{os.getenv('RENTVINE_API_SECRET', '')}".encode()
).decode()

MGMT_COMPANY = os.getenv('MGMT_COMPANY_NAME', 'Aloe Property Management')
MGMT_PHONE   = os.getenv('MGMT_PHONE', '(602) 854-9884')
MGMT_EMAIL   = os.getenv('MGMT_EMAIL', 'info@aloepm.com')
MGMT_ADDRESS = os.getenv('MGMT_ADDRESS', '')


class RentvinAPI:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'Authorization': f'Basic {RENTVINE_AUTH}',
            'Accept': 'application/json',
        })

    def _get(self, path, params=None):
        url = f"{RENTVINE_BASE}{path}"
        r = self.session.get(url, params=params or {}, timeout=30)
        if not r.ok:
            raise Exception(f"Rentvine {r.status_code}: {r.text[:200]}")
        return r.json()

    def get_active_leases(self):
        """Get all active leases with tenant + property info."""
        try:
            data = self._get('/leases/export', {'pageSize': 200, 'primaryLeaseStatusIDs[]': 1})
            leases = []
            for item in (data if isinstance(data, list) else []):
                lease = item.get('lease', {})
                unit = item.get('unit', {})
                prop = item.get('property', {})
                tenants = lease.get('tenants', [])
                tenant_name = tenants[0].get('name', '') if tenants else ''
                leases.append({
                    'leaseID': lease.get('leaseID', ''),
                    'tenant': tenant_name,
                    'address': unit.get('address', '') or prop.get('address', ''),
                    'city': unit.get('city', '') or prop.get('city', ''),
                    'endDate': lease.get('endDate', ''),
                })
            return sorted(leases, key=lambda x: x.get('address', ''))
        except Exception as e:
            logger.error(f'get_active_leases: {e}')
            return []

    def get_lease_detail(self, lease_id):
        """
        Get comprehensive lease data for PDF filling.
        Returns: tenant, all_tenants, property, lease, vehicles, community_name
        """
        try:
            # Fetch lease export filtered by leaseID
            all_leases = self._get('/leases/export', {
                'pageSize': 200,
                'primaryLeaseStatusIDs[]': 1
            })

            if not isinstance(all_leases, list):
                return {'error': 'Unexpected Rentvine response format'}

            # Find our lease
            lease_item = None
            for item in all_leases:
                l = item.get('lease', {})
                if str(l.get('leaseID', '')) == str(lease_id):
                    lease_item = item
                    break

            # Also check inactive
            if not lease_item:
                all_inactive = self._get('/leases/export', {
                    'pageSize': 50,
                    'primaryLeaseStatusIDs[]': 2
                })
                for item in (all_inactive if isinstance(all_inactive, list) else []):
                    l = item.get('lease', {})
                    if str(l.get('leaseID', '')) == str(lease_id):
                        lease_item = item
                        break

            if not lease_item:
                return {'error': f'Lease {lease_id} not found'}

            lease = lease_item.get('lease', {})
            unit = lease_item.get('unit', {})
            prop = lease_item.get('property', {})
            portfolio = lease_item.get('portfolio', {})

            # Tenant(s)
            tenants = lease.get('tenants', [])
            primary_tenant = tenants[0] if tenants else {}
            all_tenant_names = [t.get('name', '') for t in tenants if t.get('name')]

            # Community name from portfolio/property groups
            community_name = self._get_community_name(prop.get('propertyID'), portfolio)

            # Vehicles
            vehicles = self._get_vehicles(lease_id)

            # Format dates nicely
            def fmt_date(d):
                if not d:
                    return ''
                try:
                    return datetime.strptime(d[:10], '%Y-%m-%d').strftime('%m/%d/%Y')
                except Exception:
                    return d[:10] if d else ''

            address = unit.get('address') or prop.get('address', '')
            city = unit.get('city') or prop.get('city', '')
            state = unit.get('stateID') or prop.get('stateID', 'AZ')
            zip_code = unit.get('postalCode') or prop.get('postalCode', '')
            full_address = f"{address}, {city}, {state} {zip_code}".strip(', ')

            return {
                'lease_id': lease_id,
                'tenant': {
                    'name': primary_tenant.get('name', ''),
                    'email': primary_tenant.get('email', ''),
                    'phone': primary_tenant.get('phone', ''),
                    'contactID': primary_tenant.get('contactID', ''),
                },
                'all_tenants': all_tenant_names,
                'all_tenants_str': ' / '.join(all_tenant_names),
                'property': {
                    'address': address,
                    'city': city,
                    'state': state,
                    'zip': zip_code,
                    'full_address': full_address,
                    'propertyID': prop.get('propertyID', ''),
                },
                'lease': {
                    'leaseID': lease_id,
                    'startDate': fmt_date(lease.get('startDate')),
                    'endDate': fmt_date(lease.get('endDate')),
                    'moveInDate': fmt_date(lease.get('moveInDate')),
                    'rent': unit.get('rent', ''),
                    'deposit': unit.get('deposit', ''),
                    'beds': unit.get('beds', ''),
                    'baths': unit.get('fullBaths', ''),
                },
                'community_name': community_name,
                'vehicles': vehicles,
                'management': {
                    'company': MGMT_COMPANY,
                    'phone': MGMT_PHONE,
                    'email': MGMT_EMAIL,
                    'address': MGMT_ADDRESS,
                },
            }

        except Exception as e:
            logger.error(f'get_lease_detail {lease_id}: {e}', exc_info=True)
            return {'error': str(e)}

    def _get_community_name(self, property_id, portfolio):
        """Try to get HOA community name from property groups."""
        try:
            if portfolio and isinstance(portfolio, dict):
                name = portfolio.get('name', '')
                if name:
                    return name

            if property_id:
                prop_data = self._get(f'/properties/{property_id}')
                groups = prop_data.get('groups', [])
                if groups and isinstance(groups, list):
                    return groups[0].get('name', '')
        except Exception as e:
            logger.warning(f'_get_community_name: {e}')
        return ''

    def _get_vehicles(self, lease_id):
        """Fetch vehicle registrations for a lease."""
        try:
            data = self._get(f'/leases/{lease_id}/vehicles')
            if not isinstance(data, list):
                return []
            vehicles = []
            for v in data:
                vehicles.append({
                    'make': v.get('make', ''),
                    'model': v.get('model', ''),
                    'year': v.get('yearBuilt', ''),
                    'color': v.get('color', ''),
                    'plate': v.get('plateNumber', ''),
                    'plate_state': v.get('plateState', 'AZ'),
                    'description': f"{v.get('yearBuilt', '')} {v.get('make', '')} {v.get('model', '')}".strip(),
                })
            return vehicles
        except Exception as e:
            logger.warning(f'_get_vehicles {lease_id}: {e}')
            return []

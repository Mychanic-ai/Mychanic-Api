/**
 * Shop type definitions
 */

export type ShopType = 
  | 'auto_repair' 
  | 'tire_shop' 
  | 'specialty' 
  | 'mobile_mechanic' 
  | 'dealership'

export type SubscriptionStatus = 'active' | 'inactive' | 'trial' | 'cancelled'

export type SubscriptionPlan = 'basic' | 'pro' | 'enterprise'

export interface Shop {
  id: string
  owner_id: string
  name: string
  address?: string
  city?: string
  state?: string
  zip?: string
  phone?: string
  shop_type?: ShopType
  subscription_status: SubscriptionStatus
  subscription_plan: SubscriptionPlan
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface ShopRegistrationData {
  // Shop details
  shopName: string
  shopAddress: string
  shopCity: string
  shopState: string
  shopZip: string
  shopPhone: string
  shopType: ShopType
  
  // Owner details
  ownerFirstName: string
  ownerLastName: string
  email: string
  password: string
}

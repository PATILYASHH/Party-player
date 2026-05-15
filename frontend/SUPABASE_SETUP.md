# Setting Up Supabase Database for Party Player

## Step 1: Run Database Schema
1. Go to your Supabase project dashboard (the URL is set in your `NEXT_PUBLIC_SUPABASE_URL` env var)
2. Navigate to SQL Editor
3. Copy and paste the contents of `../supabase/supabase-schema.sql` into the SQL Editor
4. Click "Run" to execute the SQL commands

This will create:
- `users` table for user profiles
- `friend_requests` table for managing friend requests
- `friendships` table for storing friendships
- `room_invites` table for room invitations
- All necessary indexes, triggers, and RLS policies

## Step 2: Verify Tables Created
After running the schema, verify in the Database → Tables section that these tables exist:
- users
- friend_requests
- friendships  
- room_invites

## Step 3: Test Authentication
1. Start the development server: `npm run dev`
2. Go to http://localhost:3000
3. Click "Sign Up" to create a test account
4. Verify the user is created in the `auth.users` table and `public.users` table

## Features Implemented

### Authentication System
- ✅ Sign up/Sign in pages with Supabase Auth
- ✅ User profile creation with unique usernames
- ✅ Session management and auto-login
- ✅ Authentication state in React context

### Friend Management
- ✅ Send friend requests by username
- ✅ Accept/decline friend requests
- ✅ View friends list with online status
- ✅ Remove friends
- ✅ Search functionality

### Room Integration
- ✅ Invite friends to rooms (hosts only)
- ✅ Room invite notifications
- ✅ Accept/decline room invites
- ✅ Backward compatibility with guest users

### Database Features
- ✅ Row Level Security (RLS) policies
- ✅ Automatic timestamps
- ✅ Unique constraints
- ✅ Optimized indexes
- ✅ Data cleanup functions

## Usage Flow

1. **New User**: Sign up → Set username/display name → Start using
2. **Add Friends**: Go to Friends page → Search by username → Send request
3. **Friend Requests**: Receive notification → Accept/decline in Friends page
4. **Room Invites**: Host clicks "Invite Friends" → Select online friends → Send invites
5. **Join via Invite**: Friend receives invite → Click "Join Room" → Automatically join

## Guest Users
The system maintains full backward compatibility:
- Guest users can still create/join rooms without authentication
- All existing functionality works unchanged
- Guest users see login/signup options in header
- Can upgrade to authenticated account anytime

## Next Steps
1. Run the SQL schema in Supabase
2. Test the complete flow with multiple accounts
3. Customize styling/features as needed
4. Deploy to production when ready
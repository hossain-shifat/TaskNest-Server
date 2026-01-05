const express = require('express')
const cors = require('cors');
const app = express()
require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_API)

const port = process.env.PORT || 3000

const admin = require("firebase-admin");

const serviceAccount = require("./tasknest-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


// middlewere
app.use(express.json())
app.use(cors())


const verifyFirebaseToken = async (req, res, next) => {

    const token = req.headers.authorization

    if (!token) {
        return res.status(401).send({ message: 'unauthorized access' })
    }

    const idToken = token.split(' ')[1]
    const decoded = await admin.auth().verifyIdToken(idToken)
    console.log("decoded in the token", decoded)
    req.decoded_email = decoded.email

    next()
}




const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.pbqwzvg.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});


async function run() {
    await client.connect();

    // collections
    const db = client.db('TaskNest')
    const userCollection = db.collection('users')
    const taskCollection = db.collection('tasks')
    const submissionCollection = db.collection('submissions')
    const paymentCollection = db.collection('payments')
    const withdrawalCollection = db.collection('withdrawals')
    const notificationCollection = db.collection('notifications')


    // middlewere with database access
    const veryfyAdmin = async (req, res, next) => {
        const email = req.decoded_email
        const query = { email }
        const user = await userCollection.findOne(query)

        if (!user || user.role !== 'admin') {
            return res.status(403).send({ message: 'forbidden access' })
        }

        next()
    }

    // verify buyer
    const veryfyBuyer = async (req, res, next) => {
        const email = req.decoded_email
        const query = { email }
        const user = await userCollection.findOne(query)

        if (!user || user.role !== 'buyer') {
            return res.status(403).send({ message: 'forbidden access' })
        }

        next()
    }

    // verify worker
    const veryfyWorker = async (req, res, next) => {
        const email = req.decoded_email
        const query = { email }
        const user = await userCollection.findOne(query)

        if (!user || user.role !== 'worker') {
            return res.status(403).send({ message: 'forbidden access' })
        }

        next()
    }


    // user related api

    //get users
    app.get('/users', verifyFirebaseToken, veryfyAdmin, async (req, res) => {
        const search = req.query.search
        const query = {}
        if (search) {
            query.$or = [
                { displayName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ]
        }

        const cursor = userCollection.find(query).sort({ createdAt: -1 })
        const result = await cursor.toArray()
        res.send(result)
    })

    //get users by email
    app.get('/users/:email', verifyFirebaseToken, async (req, res) => {
        const email = req.params.email

        if (email !== req.decoded_email) {
            return res.status(403).send({ message: 'forbidden access' })
        }

        const query = { email }
        const user = await userCollection.findOne(query)
        res.send(user)
    })

    //get users by email/role
    app.get('/users/:email/role', async (req, res) => {
        const email = req.params.email
        const query = { email }
        const user = await userCollection.findOne(query)
        res.send({ role: user?.role || 'worker' })
    })

    //get top 6 workers
    app.get('/users/top/workers', async (req, res) => {
        const query = { role: 'worker' }
        const cursor = userCollection.find(query).sort({ coin: -1 }).limit(6)
        const result = await cursor.toArray()
        res.send(result)
    })

    //create users
    app.post('/users', async (req, res) => {
        const user = req.body
        user.createdAt = new Date()
        const email = user.email

        const userExist = await userCollection.findOne({ email })
        if (userExist) {
            return res.send({ message: 'user exist' })
        }

        if (user.role === 'worker') {
            user.coin = 10
        } else if (user.role === 'buyer') {
            user.coin = 50
        } else {
            user.coin = 0
        }

        const result = await userCollection.insertOne(user)
        res.send(result)
    })

    //patch users role
    app.patch('/users/:id/role', verifyFirebaseToken, veryfyAdmin, async (req, res) => {
        const id = req.params.id
        const roleInfo = req.body
        const query = { _id: new ObjectId(id) }
        const updateDoc = {
            $set: {
                role: roleInfo.role
            }
        }
        const result = await userCollection.updateOne(query, updateDoc)
        res.send(result)
    })


    // patch user profile (displayName, bio, photoURL, bannerURL) for the user profile
    app.patch('/users/:id/profile', verifyFirebaseToken, async (req, res) => {
        const id = req.params.id
        const profileInfo = req.body
        const query = { _id: new ObjectId(id) }

        const updateDoc = {
            $set: {}
        }

        // Only update fields that are provided
        if (profileInfo.displayName !== undefined) {
            updateDoc.$set.displayName = profileInfo.displayName
        }
        if (profileInfo.bio !== undefined) {
            updateDoc.$set.bio = profileInfo.bio
        }
        if (profileInfo.photoURL !== undefined) {
            updateDoc.$set.photoURL = profileInfo.photoURL
        }
        if (profileInfo.bannerURL !== undefined) {
            updateDoc.$set.bannerURL = profileInfo.bannerURL
        }

        const result = await userCollection.updateOne(query, updateDoc)
        res.send(result)
    })

    //delete user
    app.delete('/users/:id', verifyFirebaseToken, veryfyAdmin, async (req, res) => {
        const id = req.params.id
        const query = { _id: new ObjectId(id) }
        const result = await userCollection.deleteOne(query)
        res.send(result)
    })

    //get user stats for admin
    app.get('/users/stats/admin', verifyFirebaseToken, veryfyAdmin, async (req, res) => {
        const workerCount = await userCollection.countDocuments({ role: 'worker' })
        const buyerCount = await userCollection.countDocuments({ role: 'buyer' })

        const pipeline = [
            {
                $group: {
                    _id: null,
                    totalCoin: { $sum: '$coin' }
                }
            }
        ]
        const coinResult = await userCollection.aggregate(pipeline).toArray()
        const totalCoin = coinResult[0]?.totalCoin || 0

        const paymentPipeline = [
            {
                $group: {
                    _id: null,
                    totalPayments: { $sum: '$amount' }
                }
            }
        ]
        const paymentResult = await paymentCollection.aggregate(paymentPipeline).toArray()
        const totalPayments = paymentResult[0]?.totalPayments || 0

        res.send({
            workerCount,
            buyerCount,
            totalCoin,
            totalPayments
        })
    })


    // task related api

    //get all tasks
    app.get('/tasks', async (req, res) => {
        const query = {}
        const { buyerEmail } = req.query

        if (buyerEmail) {
            query.buyerEmail = buyerEmail
        }

        const cursor = taskCollection.find(query).sort({ completion_date: -1 })
        const result = await cursor.toArray()
        res.send(result)
    })

    //get available tasks for workers
    app.get('/tasks/available', async (req, res) => {
        const query = { required_workers: { $gt: 0 } }
        const cursor = taskCollection.find(query).sort({ createdAt: -1 })
        const result = await cursor.toArray()
        res.send(result)
    })

    //get task by id
    app.get('/tasks/:id', async (req, res) => {
        const id = req.params.id
        const query = { _id: new ObjectId(id) }
        const result = await taskCollection.findOne(query)
        res.send(result)
    })

    //create task
    app.post('/tasks', verifyFirebaseToken, veryfyBuyer, async (req, res) => {
        const task = req.body
        task.createdAt = new Date()

        const totalPayable = task.required_workers * task.payable_amount

        const buyer = await userCollection.findOne({ email: task.buyerEmail })

        if (buyer.coin < totalPayable) {
            return res.send({ message: 'insufficient coin' })
        }

        const result = await taskCollection.insertOne(task)

        const updateBuyer = {
            $inc: {
                coin: -totalPayable
            }
        }
        await userCollection.updateOne({ email: task.buyerEmail }, updateBuyer)

        res.send(result)
    })

    //update task
    app.patch('/tasks/:id', verifyFirebaseToken, veryfyBuyer, async (req, res) => {
        const id = req.params.id
        const updateInfo = req.body
        const query = { _id: new ObjectId(id) }

        const updateDoc = {
            $set: {
                task_title: updateInfo.task_title,
                task_detail: updateInfo.task_detail,
                submission_info: updateInfo.submission_info
            }
        }

        const result = await taskCollection.updateOne(query, updateDoc)
        res.send(result)
    })

    //delete task
    app.delete('/tasks/:id', verifyFirebaseToken, veryfyBuyer, async (req, res) => {
        const id = req.params.id
        const query = { _id: new ObjectId(id) }

        const task = await taskCollection.findOne(query)

        const refillAmount = task.required_workers * task.payable_amount

        const updateBuyer = {
            $inc: {
                coin: refillAmount
            }
        }
        await userCollection.updateOne({ email: task.buyerEmail }, updateBuyer)

        const result = await taskCollection.deleteOne(query)
        res.send(result)
    })

    //delete task by admin
    app.delete('/tasks/admin/:id', verifyFirebaseToken, veryfyAdmin, async (req, res) => {
        const id = req.params.id
        const query = { _id: new ObjectId(id) }
        const result = await taskCollection.deleteOne(query)
        res.send(result)
    })

    //get buyer stats
    app.get('/tasks/stats/buyer', verifyFirebaseToken, veryfyBuyer, async (req, res) => {
        const email = req.query.email

        if (email !== req.decoded_email) {
            return res.status(403).send({ message: 'forbidden access' })
        }

        const taskCount = await taskCollection.countDocuments({ buyerEmail: email })

        const pipeline = [
            {
                $match: { buyerEmail: email }
            },
            {
                $group: {
                    _id: null,
                    pendingTask: { $sum: '$required_workers' }
                }
            }
        ]
        const pendingResult = await taskCollection.aggregate(pipeline).toArray()
        const pendingTask = pendingResult[0]?.pendingTask || 0

        const paymentPipeline = [
            {
                $match: { buyerEmail: email }
            },
            {
                $group: {
                    _id: null,
                    totalPayment: { $sum: '$amount' }
                }
            }
        ]
        const paymentResult = await paymentCollection.aggregate(paymentPipeline).toArray()
        const totalPayment = paymentResult[0]?.totalPayment || 0

        res.send({
            taskCount,
            pendingTask,
            totalPayment
        })
    })


    // submission related api

    //get all submissions
    app.get('/submissions', verifyFirebaseToken, async (req, res) => {
        const { workerEmail, buyerEmail, status } = req.query
        const query = {}

        if (workerEmail) {
            query.workerEmail = workerEmail
        }

        if (buyerEmail) {
            query.buyerEmail = buyerEmail
        }

        if (status) {
            query.status = status
        }

        const cursor = submissionCollection.find(query).sort({ current_date: -1 })
        const result = await cursor.toArray()
        res.send(result)
    })

    //get submissions with pagination
    app.get('/submissions/paginated', verifyFirebaseToken, veryfyWorker, async (req, res) => {
        const email = req.query.email
        const page = parseInt(req.query.page) || 1
        const limit = parseInt(req.query.limit) || 10

        if (email !== req.decoded_email) {
            return res.status(403).send({ message: 'forbidden access' })
        }

        const query = { workerEmail: email }
        const skip = (page - 1) * limit

        const cursor = submissionCollection.find(query).sort({ current_date: -1 }).skip(skip).limit(limit)
        const result = await cursor.toArray()

        const total = await submissionCollection.countDocuments(query)

        res.send({
            submissions: result,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        })
    })

    //create submission
    app.post('/submissions', verifyFirebaseToken, veryfyWorker, async (req, res) => {
        const submission = req.body
        submission.current_date = new Date()
        submission.status = 'pending'

        const result = await submissionCollection.insertOne(submission)

        const notification = {
            message: `New submission received for task: ${submission.task_title}`,
            toEmail: submission.buyerEmail,
            actionRoute: '/dashboard/buyer-home',
            time: new Date()
        }
        await notificationCollection.insertOne(notification)

        res.send(result)
    })

    //approve submission
    app.patch('/submissions/:id/approve', verifyFirebaseToken, veryfyBuyer, async (req, res) => {
        const id = req.params.id
        const query = { _id: new ObjectId(id) }

        const submission = await submissionCollection.findOne(query)

        const updateDoc = {
            $set: {
                status: 'approved'
            }
        }

        const result = await submissionCollection.updateOne(query, updateDoc)

        const updateWorker = {
            $inc: {
                coin: submission.payable_amount
            }
        }
        await userCollection.updateOne({ email: submission.workerEmail }, updateWorker)

        const notification = {
            message: `You have earned ${submission.payable_amount} coins from ${submission.buyerName} for completing ${submission.task_title}`,
            toEmail: submission.workerEmail,
            actionRoute: '/dashboard/worker-home',
            time: new Date()
        }
        await notificationCollection.insertOne(notification)

        res.send(result)
    })

    //reject submission
    app.patch('/submissions/:id/reject', verifyFirebaseToken, veryfyBuyer, async (req, res) => {
        const id = req.params.id
        const query = { _id: new ObjectId(id) }

        const submission = await submissionCollection.findOne(query)

        const updateDoc = {
            $set: {
                status: 'rejected'
            }
        }

        const result = await submissionCollection.updateOne(query, updateDoc)

        const updateTask = {
            $inc: {
                required_workers: 1
            }
        }
        await taskCollection.updateOne({ _id: new ObjectId(submission.task_id) }, updateTask)

        const notification = {
            message: `Your submission for ${submission.task_title} was rejected by ${submission.buyerName}`,
            toEmail: submission.workerEmail,
            actionRoute: '/dashboard/my-submissions',
            time: new Date()
        }
        await notificationCollection.insertOne(notification)

        res.send(result)
    })

    //get worker stats
    app.get('/submissions/stats/worker', verifyFirebaseToken, veryfyWorker, async (req, res) => {
        const email = req.query.email

        if (email !== req.decoded_email) {
            return res.status(403).send({ message: 'forbidden access' })
        }

        const totalSubmission = await submissionCollection.countDocuments({ workerEmail: email })
        const pendingSubmission = await submissionCollection.countDocuments({ workerEmail: email, status: 'pending' })

        const pipeline = [
            {
                $match: { workerEmail: email, status: 'approved' }
            },
            {
                $group: {
                    _id: null,
                    totalEarning: { $sum: '$payable_amount' }
                }
            }
        ]
        const earningResult = await submissionCollection.aggregate(pipeline).toArray()
        const totalEarning = earningResult[0]?.totalEarning || 0

        res.send({
            totalSubmission,
            pendingSubmission,
            totalEarning
        })
    })


    // payment api for coin purchase

    app.post('/payment-checkout-session', verifyFirebaseToken, veryfyBuyer, async (req, res) => {
        const paymentInfo = req.body
        const amount = parseInt(paymentInfo.amount) * 100

        const session = await stripe.checkout.sessions.create({
            line_items: [
                {
                    price_data: {
                        currency: 'USD',
                        unit_amount: amount,
                        product_data: {
                            name: `Purchase ${paymentInfo.coin} Coins`
                        }
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            metadata: {
                coin: paymentInfo.coin,
                buyerEmail: paymentInfo.buyerEmail
            },
            customer_email: paymentInfo.buyerEmail,
            success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
        });
        res.send({ url: session.url })
    })

    //for payment success
    app.patch('/payment-success', verifyFirebaseToken, async (req, res) => {
        const sessionId = req.query.session_id
        const session = await stripe.checkout.sessions.retrieve(sessionId)

        console.log('session retrieve', session)

        const transactionId = session.payment_intent

        const query = { transactionId: transactionId }

        const paymentExist = await paymentCollection.findOne(query)

        if (paymentExist) {
            return res.send({
                message: 'already exist',
                transactionId,
                amount: paymentExist.amount,
                coin: paymentExist.coin,
                buyerEmail: paymentExist.buyerEmail,
                paidAt: paymentExist.paidAt
            })
        }

        if (session.payment_status === 'paid') {
            const coin = parseInt(session.metadata.coin)
            const buyerEmail = session.metadata.buyerEmail

            const updateBuyer = {
                $inc: {
                    coin: coin
                }
            }
            await userCollection.updateOne({ email: buyerEmail }, updateBuyer)

            const payment = {
                amount: session.amount_total / 100,
                coin: coin,
                currency: session.currency,
                buyerEmail: buyerEmail,
                transactionId: session.payment_intent,
                paymentStatus: session.payment_status,
                paidAt: new Date()
            }

            const resultPayment = await paymentCollection.insertOne(payment)

            res.send({
                success: true,
                transactionId: session.payment_intent,
                amount: session.amount_total / 100,
                coin: coin,
                buyerEmail: buyerEmail,
                paidAt: new Date(),
                paymentInfo: resultPayment
            })

            return
        }

        res.send({ success: false })
    })

    // payment history
    app.get('/payments', verifyFirebaseToken, async (req, res) => {
        const email = req.query.email

        if (email !== req.decoded_email) {
            return res.status(403).send({ message: 'forbidden access' })
        }

        const query = { buyerEmail: email }
        const cursor = paymentCollection.find(query).sort({ paidAt: -1 })
        const result = await cursor.toArray()
        res.send(result)
    })


    // withdrawal api

    //get all withdrawals
    app.get('/withdrawals', verifyFirebaseToken, async (req, res) => {
        const { workerEmail, status } = req.query
        const query = {}

        if (workerEmail) {
            query.workerEmail = workerEmail
        }

        if (status) {
            query.status = status
        }

        const cursor = withdrawalCollection.find(query).sort({ withdraw_date: -1 })
        const result = await cursor.toArray()
        res.send(result)
    })

    //get pending withdrawals for admin
    app.get('/withdrawals/pending', verifyFirebaseToken, veryfyAdmin, async (req, res) => {
        const query = { status: 'pending' }
        const cursor = withdrawalCollection.find(query).sort({ withdraw_date: -1 })
        const result = await cursor.toArray()
        res.send(result)
    })

    //create withdrawal
    app.post('/withdrawals', verifyFirebaseToken, veryfyWorker, async (req, res) => {
        const withdrawal = req.body
        withdrawal.withdraw_date = new Date()
        withdrawal.status = 'pending'

        const result = await withdrawalCollection.insertOne(withdrawal)
        res.send(result)
    })

    //approve withdrawal
    app.patch('/withdrawals/:id/approve', verifyFirebaseToken, veryfyAdmin, async (req, res) => {
        const id = req.params.id
        const query = { _id: new ObjectId(id) }

        const withdrawal = await withdrawalCollection.findOne(query)

        const updateDoc = {
            $set: {
                status: 'approved'
            }
        }

        const result = await withdrawalCollection.updateOne(query, updateDoc)

        const updateWorker = {
            $inc: {
                coin: -withdrawal.withdrawal_coin
            }
        }
        await userCollection.updateOne({ email: withdrawal.workerEmail }, updateWorker)

        const notification = {
            message: `Your withdrawal request of ${withdrawal.withdrawal_amount} USD has been approved`,
            toEmail: withdrawal.workerEmail,
            actionRoute: '/dashboard/withdrawals',
            time: new Date()
        }
        await notificationCollection.insertOne(notification)

        res.send(result)
    })


    // notification api

    //get notifications
    app.get('/notifications', verifyFirebaseToken, async (req, res) => {
        const email = req.query.email

        if (email !== req.decoded_email) {
            return res.status(403).send({ message: 'forbidden access' })
        }

        const query = { toEmail: email }
        const cursor = notificationCollection.find(query).sort({ time: -1 })
        const result = await cursor.toArray()
        res.send(result)
    })

    //delete notification
    app.delete('/notifications/:id', verifyFirebaseToken, async (req, res) => {
        const id = req.params.id
        const query = { _id: new ObjectId(id) }
        const result = await notificationCollection.deleteOne(query)
        res.send(result)
    })


}
run().catch(console.dir);



app.get('/', (req, res) => {
    res.send('TaskNest Platform is running')
})

app.listen(port, () => {
    console.log(`TaskNest Platform listening on port ${port}`)
})

const Broker = require('../broker')
const shuffle = require('../utils/shuffle')
const arrayDiff = require('../utils/arrayDiff')
const { KafkaJSBrokerNotFound } = require('../errors')

const { keys, assign, values } = Object
const hasBrokerBeenReplaced = (broker, { host, port, rack }) =>
  broker.connection.host !== host ||
  broker.connection.port !== port ||
  broker.connection.rack !== rack

module.exports = class BrokerPool {
  /**
   * @param {ConnectionBuilder} connectionBuilder
   * @param {Logger} logger
   * @param {Object} retry
   * @param {number} authenticationTimeout
   * @param {number} metadataMaxAge
   */
  constructor({
    connectionBuilder,
    logger,
    allowExperimentalV011,
    allowAutoTopicCreation,
    authenticationTimeout,
    metadataMaxAge,
  }) {
    this.rootLogger = logger
    this.connectionBuilder = connectionBuilder
    this.metadataMaxAge = metadataMaxAge || 0
    this.logger = logger.namespace('BrokerPool')

    this.createBroker = options =>
      new Broker({
        allowExperimentalV011,
        allowAutoTopicCreation,
        authenticationTimeout,
        ...options,
      })

    this.seedBroker = this.createBroker({
      connection: this.connectionBuilder.build(),
      logger: this.rootLogger,
    })

    this.brokers = {}
    this.metadata = null
    this.metadataExpireAt = null
    this.versions = null
    this.supportAuthenticationProtocol = null
  }

  /**
   * @public
   * @returns {Boolean}
   */
  hasConnectedBrokers() {
    const brokers = values(this.brokers)
    return !!brokers.find(broker => broker.isConnected()) || this.seedBroker.isConnected()
  }

  /**
   * @public
   * @returns {Promise<null>}
   */
  async connect() {
    if (this.hasConnectedBrokers()) {
      return
    }
    return this.seedBroker.connect()
  }

  /**
   * @public
   * @returns {Promise}
   */
  async disconnect() {
    await this.seedBroker.disconnect()
    await Promise.all(values(this.brokers).map(broker => broker.disconnect()))

    this.brokers = {}
    this.metadata = null
    this.versions = null
    this.supportAuthenticationProtocol = null
  }

  /**
   * @public
   * @param {Array<String>} topics
   * @returns {Promise<null>}
   */
  async refreshMetadata(topics) {
    const broker = await this.findConnectedBroker()
    const { host: seedHost, port: seedPort } = this.seedBroker.connection

    this.metadata = await broker.metadata(topics)
    this.metadataExpireAt = Date.now() + this.metadataMaxAge

    const replacedBrokers = []
    this.brokers = this.metadata.brokers.reduce((result, { nodeId, host, port, rack }) => {
      if (result[nodeId]) {
        if (!hasBrokerBeenReplaced(result[nodeId], { host, port, rack })) {
          return result
        }

        replacedBrokers.push(result[nodeId])
      }

      if (host === seedHost && port === seedPort) {
        this.seedBroker.nodeId = nodeId
        this.seedBroker.connection.rack = rack
        return assign(result, {
          [nodeId]: this.seedBroker,
        })
      }

      return assign(result, {
        [nodeId]: this.createBroker({
          logger: this.rootLogger,
          versions: this.versions,
          supportAuthenticationProtocol: this.supportAuthenticationProtocol,
          connection: this.connectionBuilder.build({ host, port, rack }),
          nodeId,
        }),
      })
    }, this.brokers)

    const freshBrokerIds = this.metadata.brokers.map(({ nodeId }) => `${nodeId}`).sort()
    const currentBrokerIds = keys(this.brokers).sort()
    const unusedBrokerIds = arrayDiff(currentBrokerIds, freshBrokerIds)

    const brokerDisconnects = unusedBrokerIds.map(nodeId => {
      const broker = this.brokers[nodeId]
      return broker.disconnect().then(() => {
        delete this.brokers[nodeId]
      })
    })

    const replacedBrokersDisconnects = replacedBrokers.map(broker => broker.disconnect())
    return Promise.all([...brokerDisconnects, ...replacedBrokersDisconnects])
  }

  /**
   * Only refreshes metadata if the data is stale according to the `metadataMaxAge` param
   *
   * @public
   * @param {Array<String>} topics
   * @returns {Promise<null>}
   */
  async refreshMetadataIfNecessary(topics) {
    const shouldRefresh =
      this.metadata == null || this.metadataExpireAt == null || Date.now() > this.metadataExpireAt

    if (shouldRefresh) {
      return this.refreshMetadata(topics)
    }
  }

  /**
   * @public
   * @param {string} nodeId
   * @returns {Promise<Broker>}
   */
  async findBroker({ nodeId }) {
    const broker = this.brokers[nodeId]

    if (!broker) {
      throw new KafkaJSBrokerNotFound(`Broker ${nodeId} not found in the cached metadata`)
    }

    await this.connectBroker(broker)
    return broker
  }

  /**
   * @public
   * @param {Promise<{ nodeId<String>, broker<Broker> }>} callback
   * @returns {Promise<null>}
   */
  async withBroker(callback) {
    const brokers = shuffle(keys(this.brokers))
    if (brokers.length === 0) {
      throw new KafkaJSBrokerNotFound('No brokers in the broker pool')
    }

    for (const nodeId of brokers) {
      const broker = await this.findBroker({ nodeId })
      try {
        return await callback({ nodeId, broker })
      } catch (e) {}
    }

    return null
  }

  /**
   * @public
   * @returns {Promise<Broker>}
   */
  async findConnectedBroker() {
    const nodeIds = shuffle(keys(this.brokers))
    const connectedBrokerId = nodeIds.find(nodeId => this.brokers[nodeId].isConnected())

    if (connectedBrokerId) {
      return await this.findBroker({ nodeId: connectedBrokerId })
    }

    // Cycle through the nodes until one connects
    for (const nodeId of nodeIds) {
      try {
        return await this.findBroker({ nodeId })
      } catch (e) {}
    }

    // Failed to connect to all known brokers, metadata might be old
    await this.connect()
    return this.seedBroker
  }

  /**
   * @private
   * @param {Broker} broker
   * @returns {Promise<null>}
   */
  async connectBroker(broker) {
    if (broker.isConnected()) {
      return
    }
    return broker.connect()
  }
}
